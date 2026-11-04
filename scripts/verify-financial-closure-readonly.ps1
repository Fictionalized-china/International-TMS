#Requires -Version 7.0
param(
  [Parameter(Mandatory=$true)][string]$CredentialsPath,
  [string]$BaseUrl='https://tms.shxlh.com',
  [string]$OrderId='6dc926e7-661f-498d-be88-82978afd65c6',
  [string]$OrderNumber='SO2026110300027'
)
$ErrorActionPreference='Stop'
# For the approved, signed but unpaid demo order. Only login POSTs and page GETs.
# These assertions intentionally fail after the demo order is actually settled.
$accounts=@(Get-Content -LiteralPath $CredentialsPath -Encoding utf8 | ForEach-Object {
  if($_ -match '^\|'){
    $cells=$_.Trim('|').Split('|') | ForEach-Object {$_.Trim().Trim([char]96)}
    if($cells.Count -ge 6 -and $cells[3] -match '@'){[pscustomobject]@{Email=$cells[3];Password=$cells[4]}}
  }
})
function Read-Page($context,[string]$path){
  $builder=[System.UriBuilder]::new([uri]::new([uri]$BaseUrl,$path))
  $query=[System.Web.HttpUtility]::ParseQueryString($builder.Query)
  if($context.Slot){$query['itmsTab']=$context.Slot}
  $builder.Query=$query.ToString()
  for($attempt=1;$attempt -le 2;$attempt++){
    try{$response=Invoke-WebRequest $builder.Uri -WebSession $context.Session -TimeoutSec 60 -SkipHttpErrorCheck;break}
    catch{if($attempt -eq 2){throw};Write-Host "RETRY slot=$($context.Index) read-only transport failure"}
  }
  if($response.StatusCode -ne 200 -or $response.BaseResponse.RequestMessage.RequestUri.AbsolutePath -match '/login$' -or $response.Content -match 'SYSTEM RECOVERY|502 Bad Gateway'){throw "Slot $($context.Index): failed page $path"}
  return [regex]::Replace($response.Content,'(?s)<script\b[^>]*>.*?</script>','')
}
function Statement-Form([string]$html,[string]$direction){
  return @([regex]::Matches($html,'(?s)<form\b[^>]*>.*?</form>') | Where-Object {
    $_.Value -match 'name="intent"[^>]*value="create_reconciliation"' -and $_.Value -match ('name="direction"[^>]*value="'+$direction+'"')
  }).Count -gt 0
}
foreach($index in @(7,10,11)){
  $session=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
  $login=Invoke-WebRequest "$BaseUrl/login" -WebSession $session -TimeoutSec 45
  $signed=Invoke-WebRequest $login.BaseResponse.RequestMessage.RequestUri -Method Post -Body @{email=$accounts[$index].Email;password=$accounts[$index].Password} -WebSession $session -TimeoutSec 45
  $signedUri=$signed.BaseResponse.RequestMessage.RequestUri
  if(!$signedUri.AbsolutePath.StartsWith('/admin')){throw "Slot $index login failed"}
  $context=[pscustomobject]@{Index=$index;Session=$session;Slot=[System.Web.HttpUtility]::ParseQueryString($signedUri.Query)['itmsTab']}
  if($index -in @(7,10)){
    $pending=Read-Page $context "/admin/billing?tab=pending&q=$OrderNumber"
    $receivable=Statement-Form $pending 'receivable'
    # Pending defaults to AR. Follow the AP-filtered entrance provided to finance.
    $payable=if($index -eq 10){Statement-Form (Read-Page $context "/admin/billing?tab=pending&q=$OrderNumber&direction=payable") 'payable'}else{$false}
    if($index -eq 7 -and !$receivable){throw 'Assigned CS cannot generate the approved AR statement'}
    if($index -eq 10 -and ($receivable -or !$payable)){throw 'Finance AR/AP statement controls disagree with configured creators'}
    Write-Host "PASS slot=$index statement creation controls AR=$receivable AP=$payable"
  }
  if($index -eq 10){
    $review=Read-Page $context "/admin/orders/${OrderId}?stage=completion_review&module=review"
    if($review -notmatch '必办模块未完成|财务闭环|真实收付款核销'){throw 'Final archive lacks a visible financial blocker'}
    if($review -match 'name="intent"[^>]*value="finalize_order_review"'){throw 'Unpaid order unexpectedly exposes finalization form'}
    Write-Host 'PASS finance final archive remains blocked before true funds settlement'
  }
  if($index -eq 11){
    $cash=Read-Page $context "/admin/billing?tab=cash&q=$OrderNumber"
    if($cash -notmatch '收付款与核销' -or $cash -notmatch 'name="intent"[^>]*value="record_cash"'){throw 'Cashier real cash registration entrance missing'}
    if($cash -match 'name="intent"[^>]*value="allocate_cash"'){throw 'No confirmed statement exists yet; allocation should not be offered'}
    Write-Host 'PASS cashier can register true funds; allocation awaits a confirmed statement'
  }
}
Write-Output 'Financial closure read-only checks passed. No business forms submitted.'
