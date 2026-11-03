#Requires -Version 7.0
param(
  [Parameter(Mandatory=$true)][string]$CredentialsPath,
  [string]$BaseUrl='https://tms.shxlh.com',
  [switch]$Focused
)
$ErrorActionPreference='Stop'
# Only authentication POSTs and page GETs. Never submit a business form.
$accounts=@(Get-Content -LiteralPath $CredentialsPath -Encoding utf8 | ForEach-Object {
  if($_ -match '^\|') {
    $cells=$_.Trim('|').Split('|') | ForEach-Object {$_.Trim().Trim([char]96)}
    if($cells.Count -ge 6 -and $cells[3] -match '@') {
      [pscustomobject]@{Email=$cells[3];Password=$cells[4]}
    }
  }
})
if($accounts.Count -lt 15){throw 'Approved credential table is incomplete'}
$pageChecks=0
function Response-Uri($response){return [uri]$response.BaseResponse.RequestMessage.RequestUri}
function Open-Account([int]$index){
  $session=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
  $login=Invoke-WebRequest "$BaseUrl/login" -WebSession $session -TimeoutSec 45
  $response=Invoke-WebRequest (Response-Uri $login).AbsoluteUri -Method Post -Body @{email=$accounts[$index].Email;password=$accounts[$index].Password} -WebSession $session -TimeoutSec 45
  $uri=Response-Uri $response
  if($response.StatusCode -ne 200 -or !$uri.AbsolutePath.StartsWith('/admin')){throw "Authentication failed for account slot $index"}
  return [pscustomobject]@{Session=$session;Query=$uri.Query;Index=$index}
}
function Read-AccessPage($context,[string]$path,[int]$expected=200){
  $uri=[uri]::new([uri]$BaseUrl,$path)
  if($uri.Host -ne ([uri]$BaseUrl).Host -or !$uri.AbsolutePath.StartsWith('/admin')){throw 'Refusing non-admin or off-site link'}
  $builder=[System.UriBuilder]::new($uri)
  $query=[System.Web.HttpUtility]::ParseQueryString($builder.Query)
  $sessionQuery=[System.Web.HttpUtility]::ParseQueryString($context.Query)
  if($sessionQuery['itmsTab']){$query['itmsTab']=$sessionQuery['itmsTab']}
  $builder.Query=$query.ToString()
  $response=Invoke-WebRequest $builder.Uri -WebSession $context.Session -SkipHttpErrorCheck -TimeoutSec 45
  $resultUri=Response-Uri $response
  if($response.StatusCode -ne $expected -or $resultUri.AbsolutePath -match '/login$' -or ($expected -eq 200 -and $response.Content -match 'SYSTEM RECOVERY|502 Bad Gateway')){
    throw "Slot $($context.Index): $path expected $expected, received $($response.StatusCode) at $($resultUri.AbsolutePath)"
  }
  $script:pageChecks++
  Write-Host "PASS slot=$($context.Index) HTTP $expected $path"
  return $response
}
function Sidebar($page){return [regex]::Match($page.Content,'(?s)<aside\b.*?</aside>').Value}
$contexts=@{}
$indices=if($Focused){@(0,4,5,8,10)}else{@(0,1,2,4,5,6,7,8,10,11,12)}
foreach($index in $indices){
  $context=Open-Account $index
  $contexts[$index]=$context
  $page=Read-AccessPage $context '/admin/portal'
  if($Focused){continue}
  $sidebar=Sidebar $page
  if(!$sidebar){throw "No sidebar for slot $index"}
  $links=@([regex]::Matches($sidebar,'href="([^"]+)"') | ForEach-Object {[System.Net.WebUtility]::HtmlDecode($_.Groups[1].Value)} | Where-Object {$_ -match '^/admin(?:/|\?|$)'} | Select-Object -Unique)
  foreach($link in $links){$null=Read-AccessPage $context $link}
  # Portal quick links are ordinary secondary links; check their registered pages too.
  $quickLinks=@([regex]::Matches($page.Content,'href="([^"]+)"') | ForEach-Object {[System.Net.WebUtility]::HtmlDecode($_.Groups[1].Value)} | Where-Object {$_ -match '^/admin/(workbenches/|dispatch|carriers|positions|roles|billing|orders)(?:[^/]*)$'} | Select-Object -Unique)
  foreach($link in $quickLinks){$null=Read-AccessPage $context $link}
}
$operation=$contexts[5]
$page=Read-AccessPage $operation '/admin/portal'
if((Sidebar $page) -match '调度与运踪'){throw 'Operation sidebar still exposes overseas tracking'}
foreach($path in @('/admin/tracking-center','/admin/workbenches/tracking','/admin/workbenches/costs','/admin/dispatch')){
  $null=Read-AccessPage $operation $path 403
}
$null=Read-AccessPage $operation '/admin/shipments'
$commercial=$contexts[8]
$page=Read-AccessPage $commercial '/admin/dispatch'
if((Sidebar $page) -notmatch 'href="/admin/dispatch[^\"]*"[^>]*>.*?找车'){throw 'Commercial primary dispatch entrance missing'}
foreach($path in @('/admin/tracking-center?dispatchTask=pending','/admin/workbenches/dispatch')){
  $redirect=Read-AccessPage $commercial $path
  if((Response-Uri $redirect).AbsolutePath -ne '/admin/dispatch'){throw "Historical dispatch redirect failed: $path"}
}
$notifications=Read-AccessPage $commercial '/admin/notifications'
if($notifications.Content -match 'href="/admin/orders/[^\"]+/modules/dispatch'){throw 'Historical invalid dispatch notification link remains'}
$planning=Read-AccessPage $contexts[4] '/admin/loading'
if($planning.Content -notmatch 'aria-label="筛选待配载订单"'){throw 'Loading planning filters missing'}
foreach($label in @('订单 / 货物','装车仓库','境外目的仓','境外目的地','出境口岸')){
  if($planning.Content -notmatch [regex]::Escape($label)){throw "Planning filter missing: $label"}
}
$null=Read-AccessPage $contexts[10] '/admin/workbenches/costs'
$null=Read-AccessPage $contexts[0] '/admin/dispatch'
$null=Read-AccessPage $contexts[0] '/admin/workbenches/costs'
foreach($workspace in @('tasks','documents','customs','tracking','costs')){
  $null=Read-AccessPage $contexts[0] "/admin/workbenches/$workspace"
}
Write-Output "Read-only access verification complete: $pageChecks page checks. No business forms submitted."
