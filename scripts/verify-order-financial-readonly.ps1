#Requires -Version 7.0
param(
  [Parameter(Mandatory=$true)][string]$CredentialsPath,
  [string]$BaseUrl='https://tms.shxlh.com',
  [string]$OrderId='6dc926e7-661f-498d-be88-82978afd65c6',
  [string]$OrderNumber='SO2026110300027'
)
$ErrorActionPreference='Stop'
# Login POSTs and page GETs only. Never generate statements or invent funds.
$accounts=@(Get-Content -LiteralPath $CredentialsPath -Encoding utf8 | ForEach-Object {
  if($_ -match '^\|'){$cells=$_.Trim('|').Split('|') | ForEach-Object {$_.Trim().Trim([char]96)}; if($cells.Count -ge 6 -and $cells[3] -match '@'){[pscustomobject]@{Email=$cells[3];Password=$cells[4]}}}
})
function Read-Order($context,[string]$tab){
  $builder=[System.UriBuilder]::new("$BaseUrl/admin/orders/${OrderId}?stage=reconciliation&module=costs&section=expenses&financeTab=$tab")
  $query=[System.Web.HttpUtility]::ParseQueryString($builder.Query)
  if($context.Slot){$query['itmsTab']=$context.Slot}; $builder.Query=$query.ToString()
  for($attempt=1;$attempt -le 2;$attempt++){
    try{$response=Invoke-WebRequest $builder.Uri -WebSession $context.Session -TimeoutSec 60 -SkipHttpErrorCheck;break}
    catch{if($attempt -eq 2){throw};Write-Host 'RETRY read-only transport failure'}
  }
  if($response.StatusCode -ne 200 -or $response.Content -match 'SYSTEM RECOVERY|502 Bad Gateway' -or $response.BaseResponse.RequestMessage.RequestUri.AbsolutePath -match '/login$'){throw "Slot $($context.Index) order page failed: $tab HTTP $($response.StatusCode)"}
  $visible=[regex]::Replace($response.Content,'(?s)<script\b[^>]*>.*?</script>|<aside\b[^>]*>.*?</aside>','')
  if($visible -notmatch 'aria-label="本单财务办理"' -or $visible -notmatch $OrderNumber){throw 'Order financial workspace missing'}
  $forms=@([regex]::Matches($visible,'(?s)<form\b[^>]*>.*?</form>') | ForEach-Object {$_.Value})
  foreach($form in $forms){
    if($form -match 'name="intent"[^>]*value="(?:create_reconciliation|confirm_reconciliation|record_cash|allocate_cash|record_invoice|offline)"'){
      $action=[regex]::Match($form,'action="([^"]+)"')
      if(!$action.Success -or ([uri]::new([uri]$BaseUrl,[System.Net.WebUtility]::HtmlDecode($action.Groups[1].Value))).AbsolutePath -ne "/admin/orders/$OrderId"){throw 'Financial form leaves the current order'}
      if([System.Net.WebUtility]::HtmlDecode($action.Groups[1].Value) -notmatch "financeTab=$tab"){throw 'Financial form loses its active subpage'}
    }
  }
  Write-Host "PASS slot=$($context.Index) current-order $tab; action targets remain in this order"
  return [pscustomobject]@{Html=$visible;Forms=$forms}
}
foreach($index in @(7,10,11)){
  $session=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
  $login=Invoke-WebRequest "$BaseUrl/login" -WebSession $session -TimeoutSec 45
  $signed=Invoke-WebRequest $login.BaseResponse.RequestMessage.RequestUri -Method Post -Body @{email=$accounts[$index].Email;password=$accounts[$index].Password} -WebSession $session -TimeoutSec 45
  $signedUri=$signed.BaseResponse.RequestMessage.RequestUri
  if(!$signedUri.AbsolutePath.StartsWith('/admin')){throw "Slot $index login failed"}
  $context=[pscustomobject]@{Index=$index;Session=$session;Slot=[System.Web.HttpUtility]::ParseQueryString($signedUri.Query)['itmsTab']}
  $tab=if($index -eq 11){'cash'}else{'statements'}
  $page=Read-Order $context $tab
  if($index -in @(7,10)){
    $direction=if($index -eq 7){'receivable'}else{'payable'}
    if(!@($page.Forms | Where-Object {$_ -match 'value="create_reconciliation"' -and $_ -match ('name="direction"[^>]*value="'+$direction+'"')}).Count){throw "Slot $index has no own-direction creation form"}
    if($index -eq 10 -and @($page.Forms | Where-Object {$_ -match 'value="create_reconciliation"' -and $_ -match 'name="direction"[^>]*value="receivable"'}).Count){throw 'Finance has an unconfigured AR creator action'}
  }
  if($index -eq 10){
    $offline=Read-Order $context 'offline'
    if($offline.Html -notmatch 'name="intent"[^>]*value="offline"|已登记：'){throw 'Finance offline approval entrance missing'}
  }
  if($index -eq 11 -and $page.Html -notmatch '请先在“对账办理”生成并确认|匹配收付款流水并核销'){throw 'Cashier has no clear next-step explanation'}
}
Write-Output 'Order financial read-only verification passed. No financial forms submitted.'
