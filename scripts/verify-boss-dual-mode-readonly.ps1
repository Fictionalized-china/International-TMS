#Requires -Version 7.0
param(
  [Parameter(Mandatory=$true)][string]$CredentialsPath,
  [string]$BaseUrl='https://tms.shxlh.com',
  [string]$DomesticWarehouseId='34942cb0-3550-48db-a1ef-2243d088e245',
  [string]$OverseasWarehouseId='20a0ff17-2ddd-4cc7-80f7-9a187bd66553',
  [string]$OrderId='eb92e42d-b45f-4c6e-a628-0f0b7e585f03',
  [switch]$SkipBoss,
  [switch]$WarehouseOnly
)
$ErrorActionPreference='Stop'
# Only login/site-switch POSTs and page GETs. No business/financial form is submitted.
$accounts=@(Get-Content -LiteralPath $CredentialsPath -Encoding utf8 | ForEach-Object {
  if($_ -match '^\|'){$cells=$_.Trim('|').Split('|') | ForEach-Object {$_.Trim().Trim([char]96)};if($cells.Count -ge 6 -and $cells[3] -match '@'){[pscustomobject]@{Email=$cells[3];Password=$cells[4]}}}
})
if($accounts.Count -lt 15){throw 'Approved credential table is incomplete'}
function Invoke-AccessRequest([hashtable]$requestArgs){
  for($attempt=1;$attempt -le 3;$attempt++){
    try{return Invoke-WebRequest @requestArgs}
    catch{if($attempt -eq 3){throw};Write-Host 'RETRY authentication/page transport failure';Start-Sleep -Seconds 1}
  }
}
function Open-Account([int]$index,[string]$site='admin'){
  $session=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
  $loginPath=if($site -eq 'warehouse'){'/warehouse/login'}else{'/login'}
  $login=Invoke-AccessRequest @{Uri="$BaseUrl$loginPath";WebSession=$session;TimeoutSec=60;SkipHttpErrorCheck=$true}
  $signed=Invoke-AccessRequest @{Uri=$login.BaseResponse.RequestMessage.RequestUri;Method='Post';Body=@{email=$accounts[$index].Email;password=$accounts[$index].Password};WebSession=$session;TimeoutSec=60;SkipHttpErrorCheck=$true}
  $uri=$signed.BaseResponse.RequestMessage.RequestUri
  $slot=[System.Web.HttpUtility]::ParseQueryString($uri.Query)['itmsTab']
  if(!$uri.AbsolutePath.StartsWith("/$site") -or $uri.AbsolutePath.EndsWith('/login') -or !$slot){throw "Account slot $index authentication failed"}
  return [pscustomobject]@{Session=$session;Slot=$slot;Index=$index;WarehouseId=[System.Web.HttpUtility]::ParseQueryString($uri.Query)['warehouseId']}
}
function Request-Page($context,[string]$path,[hashtable]$body,[int]$expected=200){
  $builder=[System.UriBuilder]::new([uri]::new([uri]$BaseUrl,$path))
  if($builder.Host -ne ([uri]$BaseUrl).Host){throw 'Refusing off-site target'}
  $query=[System.Web.HttpUtility]::ParseQueryString($builder.Query);$query['itmsTab']=$context.Slot;$builder.Query=$query.ToString()
  $requestArgs=@{Uri=$builder.Uri;WebSession=$context.Session;TimeoutSec=60;SkipHttpErrorCheck=$true}
  if($body){if($builder.Path -ne '/switch-site'){throw 'Only the existing identity-preserving site-switch action is allowed'};$requestArgs.Method='Post';$requestArgs.Body=$body}
  $page=Invoke-AccessRequest $requestArgs
  $uri=$page.BaseResponse.RequestMessage.RequestUri
  if($page.StatusCode -ne $expected -or $uri.AbsolutePath -match '/login$' -or ($expected -eq 200 -and $page.Content -match 'SYSTEM RECOVERY|502 Bad Gateway')){throw "Account slot $($context.Index) expected $expected at $path; received $($page.StatusCode), $($uri.AbsolutePath)"}
  Write-Host "PASS slot=$($context.Index) HTTP $expected $($uri.AbsolutePath)"
  return $page
}
function Sidebar($page){return [regex]::Match($page.Content,'(?s)<aside\b.*?</aside>').Value}
if(!$SkipBoss -and !$WarehouseOnly){
$boss=Open-Account 0
foreach($path in @('/admin/orders','/admin/quotations?entryMode=direct','/admin/loading','/admin/dispatch','/admin/tracking-center','/admin/workbenches/documents','/admin/workbenches/customs','/admin/workbenches/costs','/admin/billing?view=cash',"/admin/orders/$OrderId")){
  $null=Request-Page $boss $path
}
$warehouses=Request-Page $boss '/admin/warehouses'
if($warehouses.Content -notmatch '以老板身份办理'){throw 'Boss warehouse entrance missing'}
$entry=Request-Page $boss '/switch-site' @{target='warehouse';warehouseTo="/warehouse/inbound?warehouseId=$OverseasWarehouseId&orderId=$OrderId"}
if($entry.Content -notmatch '老板全仓代办' -or $entry.Content -notmatch [regex]::Escape($accounts[0].Email)){throw 'Warehouse site did not retain the actual boss identity'}
foreach($screen in @('pickup','inventory')){$null=Request-Page $boss "/warehouse/${screen}?warehouseId=$OverseasWarehouseId"}
$null=Request-Page $boss "/switch-site?warehouseId=$OverseasWarehouseId" @{target='warehouse';sourceSite='warehouse';warehouseTo="/warehouse/acceptance?warehouseId=$DomesticWarehouseId"}
foreach($screen in @('packing','outbound','inventory')){$null=Request-Page $boss "/warehouse/${screen}?warehouseId=$DomesticWarehouseId"}
$returned=Request-Page $boss "/switch-site?warehouseId=$DomesticWarehouseId" @{target='admin';returnTo="/admin/orders/$OrderId"}
if($returned.Content -notmatch [regex]::Escape($accounts[0].Email)){throw 'Return to management lost boss identity'}
}
if(!$WarehouseOnly){foreach($index in @(2,4,5,6,7,8,10,11)){
  $context=Open-Account $index
  $page=Request-Page $context '/admin/orders'
  if($page.Content -match '老板全仓代办|以老板身份进入办理'){throw "Boss stand-in entrance leaked to ordinary account slot $index"}
  if($index -eq 5){
    if((Sidebar $page) -match '调度与运踪'){throw 'Ordinary operation account gained overseas tracking navigation'}
    $null=Request-Page $context '/admin/tracking-center' $null 403
    $null=Request-Page $context '/admin/dispatch' $null 403
  }
  if($index -eq 8){$null=Request-Page $context '/admin/dispatch'}
  if($index -in @(7,10,11)){$null=Request-Page $context '/admin/billing'}
}}
foreach($index in @(13,14)){
  $context=Open-Account $index 'warehouse'
  if(!$context.WarehouseId){throw "Warehouse account slot $index has no own warehouse context"}
  $page=Request-Page $context "/warehouse?warehouseId=$($context.WarehouseId)"
  if($page.Content -match '老板全仓代办|切换办理仓库|boss-warehouse-return'){throw "Boss warehouse controls leaked to account slot $index"}
  $null=Request-Page $context "/warehouse/inventory?warehouseId=$($context.WarehouseId)"
}
Write-Output 'Dual-mode authenticated page verification passed. Same boss identity across sites; no business/financial mutations submitted.'
