#Requires -Version 7.0
param(
  [Parameter(Mandatory=$true)][string]$CredentialsPath,
  [string]$BaseUrl='https://tms.shxlh.com',
  [string]$OrderId='6dc926e7-661f-498d-be88-82978afd65c6',
  [string]$OrderNumber='SO2026110300027',
  [int[]]$AccountIndexes=@(7,2,5,4,10,8,11,0)
)
$ErrorActionPreference='Stop'
# No signature, money, order or configuration forms are submitted.
$accounts=@(Get-Content -LiteralPath $CredentialsPath -Encoding utf8 | ForEach-Object {
  if($_ -match '^\|'){
    $cells=$_.Trim('|').Split('|') | ForEach-Object {$_.Trim().Trim([char]96)}
    if($cells.Count -ge 6 -and $cells[3] -match '@'){[pscustomobject]@{Email=$cells[3];Password=$cells[4]}}
  }
})
function Read-Page($context,[string]$path){
  $builder=[System.UriBuilder]::new([uri]::new([uri]$BaseUrl,$path))
  $query=[System.Web.HttpUtility]::ParseQueryString($builder.Query)
  $slot=[System.Web.HttpUtility]::ParseQueryString($context.Query)['itmsTab']
  if($slot){$query['itmsTab']=$slot}
  $builder.Query=$query.ToString()
  for($attempt=1;$attempt -le 2;$attempt++){
    try{$response=Invoke-WebRequest $builder.Uri -WebSession $context.Session -TimeoutSec 60 -SkipHttpErrorCheck;break}
    catch{if($attempt -eq 2){throw};Write-Host "RETRY slot=$($context.Index) transport failure reading $path"}
  }
  if($response.StatusCode -ne 200 -or $response.BaseResponse.RequestMessage.RequestUri.AbsolutePath -match '/login$' -or $response.Content -match 'SYSTEM RECOVERY|502 Bad Gateway'){
    throw "Slot $($context.Index): failed $path HTTP $($response.StatusCode)"
  }
  Write-Host "PASS slot=$($context.Index) HTTP 200 $path"
  return $response
}
function Has-SignatureForm($page,[string]$direction,[string]$action){
  foreach($match in [regex]::Matches($page.Content,'(?s)<form\b[^>]*>.*?</form>')){
    if($match.Value -match ('name="direction"[^>]*value="'+$direction+'"') -and $match.Value -match ('name="(?:action|controlAction)"[^>]*value="'+$action+'"')){return $true}
  }
  return $false
}
function Signature-Forms($page){
  $result=@()
  foreach($direction in @('receivable','payable')){
    foreach($action in @('confirm','business_review','finance_review')){
      if(Has-SignatureForm $page $direction $action){$result+="$direction/$action"}
    }
  }
  return $result
}
foreach($index in $AccountIndexes){
  $session=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
  $login=Invoke-WebRequest "$BaseUrl/login" -WebSession $session -TimeoutSec 45
  $signed=Invoke-WebRequest $login.BaseResponse.RequestMessage.RequestUri -Method Post -Body @{email=$accounts[$index].Email;password=$accounts[$index].Password} -WebSession $session -TimeoutSec 45
  $signedUri=$signed.BaseResponse.RequestMessage.RequestUri
  if(!$signedUri.AbsolutePath.StartsWith('/admin')){throw "Slot $index login failed"}
  $context=[pscustomobject]@{Index=$index;Session=$session;Query=$signedUri.Query}
  $approval=Read-Page $context "/admin/settlement-approvals?q=$OrderNumber"
  if($approval.Content -match '此客户未配置客服代办应收'){throw 'Order-entry authorization still blocks settlement'}
  if($index -ne 11 -and $approval.Content -notmatch '本单责任人：'){throw 'Canonical signature-owner hints missing'}
  if($index -in @(7,2,5,4,10,8,0)){
    $detail=Read-Page $context "/admin/orders/${OrderId}?stage=reconciliation&module=costs&section=expenses"
    if($detail.Content -match '此客户未配置客服代办应收'){throw 'Order detail still uses customer intake flag for settlement'}
    if($detail.Content -match '当前账号无[需权]办理费用结算'){throw "Slot $index blocked by financial-read permission instead of signature authority"}
    $expected=@(Signature-Forms $approval | Sort-Object)
    $actual=@(Signature-Forms $detail | Sort-Object)
    if(($expected -join ',') -ne ($actual -join ',')){throw "Slot $index embedded/independent signature mismatch: expected=$($expected -join ',') actual=$($actual -join ',')"}
    Write-Host "PASS slot=$index embedded/independent parity: $($actual -join ',')"
    if($index -ne 11 -and ($approval.Content -notmatch 'signature-expense-table' -or $detail.Content -notmatch '财务闭环办理路径')){throw "Slot $index lacks review amounts or the financial handoff path"}
    if($index -in @(5,8)){
      $visible=[regex]::Replace($detail.Content,'(?s)<script\b[^>]*>.*?</script>','')
      if($visible -match 'expense-ledger-table|预计利润|foreign_account_no'){throw "Slot $index received a financial ledger in the sign-only page"}
    }
    if($index -eq 7){
      $visible=[regex]::Replace($detail.Content,'(?s)<script\b[^>]*>.*?</script>','')
      foreach($block in [regex]::Matches($visible,'待补齐必填项：([^<]+)')){
        if($block.Value -match '单价|尚未进入对账结算节点'){throw 'A stale completed prerequisite is still shown as a blocker'}
      }
    }
  }
  if($index -in @(7,10,11)){$null=Read-Page $context '/admin/billing'}
  Write-Host "PASS slot=$index correct signatory and sequence"
}
Write-Output 'Settlement responsibility read-only checks passed. No business forms submitted.'
