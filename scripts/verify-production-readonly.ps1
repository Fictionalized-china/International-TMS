param(
  [Parameter(Mandatory=$true)][string]$CredentialsPath,
  [string]$BaseUrl = 'https://tms.shxlh.com'
)
$ErrorActionPreference = 'Stop'
# Credentials stay in memory. Only login POSTs and page GETs are issued.
$accounts = @(Get-Content -LiteralPath $CredentialsPath -Encoding utf8 | ForEach-Object {
  if ($_ -match '^\|') {
    $cells = $_.Trim('|').Split('|') | ForEach-Object { $_.Trim().Trim([char]96) }
    if ($cells.Count -ge 6 -and $cells[3] -match '@') {
      [pscustomobject]@{ Email=$cells[3]; Password=$cells[4] }
    }
  }
})
if ($accounts.Count -lt 16) { throw 'Expected owner, warehouse and portal accounts in the approved credential table' }
function Get-ResponseUri($Response) {
  if ($Response.BaseResponse.ResponseUri) { return [uri]$Response.BaseResponse.ResponseUri }
  return [uri]$Response.BaseResponse.RequestMessage.RequestUri
}
function Assert-Page($Response, [string]$Label) {
  $uri = Get-ResponseUri $Response
  if ($Response.StatusCode -ne 200 -or $uri.AbsolutePath -match '/login$' -or $Response.Content -match 'SYSTEM RECOVERY|502 Bad Gateway') {
    throw "Read-only check failed: $Label (status $($Response.StatusCode), path $($uri.AbsolutePath))"
  }
  Write-Host "PASS $Label HTTP 200"
}
function Open-Session([int]$Index, [string]$LoginPath, [string]$ExpectedPrefix) {
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $login = Invoke-WebRequest "$BaseUrl$LoginPath" -WebSession $session -UseBasicParsing -TimeoutSec 45
  $response = Invoke-WebRequest (Get-ResponseUri $login).AbsoluteUri -Method Post -Body @{email=$accounts[$Index].Email;password=$accounts[$Index].Password} -WebSession $session -UseBasicParsing -TimeoutSec 45
  $uri = Get-ResponseUri $response
  if (!$uri.AbsolutePath.StartsWith($ExpectedPrefix) -or $uri.AbsolutePath -match '/login$') { throw "Authentication failed for account slot $Index" }
  return [pscustomobject]@{Session=$session;Query=$uri.Query}
}
function Read-Page($Context,[string]$Path,[string]$Label) {
  $response = Invoke-WebRequest "$BaseUrl$Path$($Context.Query)" -WebSession $Context.Session -UseBasicParsing -TimeoutSec 45
  Assert-Page $response $Label
  return $response
}
function Read-LinkedPages($Context,$Page,[string]$Pattern,[string]$Label,[int]$Limit=2) {
  $links = @([regex]::Matches($Page.Content,'href="([^"]+)"') | ForEach-Object { [System.Net.WebUtility]::HtmlDecode($_.Groups[1].Value) } | Where-Object {$_ -match $Pattern} | Select-Object -Unique -First $Limit)
  if (!$links.Count) { Write-Output "SKIP $Label (no matching current records)"; return }
  foreach ($link in $links) {
    $uri = [uri]::new([uri]$BaseUrl,$link)
    if ($uri.Host -ne ([uri]$BaseUrl).Host) { throw 'Refusing off-site link' }
    if (!$uri.Query -and $Context.Query) { $uri = [uri]($uri.AbsoluteUri + $Context.Query) }
    $response = Invoke-WebRequest $uri -WebSession $Context.Session -UseBasicParsing -TimeoutSec 45
    Assert-Page $response $Label
  }
}
$admin = Open-Session 0 '/login' '/admin'
foreach($path in @('/admin/quotations','/admin/analytics','/admin/tracking-center','/admin/billing','/admin/shipments','/admin/workflow')) { $null = Read-Page $admin $path $path }
$orders = Read-Page $admin '/admin/orders' 'admin orders'
Read-LinkedPages $admin $orders '/admin/orders/[^/?]+(?:\?|$)' 'admin order detail'
$loading = Read-Page $admin '/admin/loading' 'admin loading list'
Read-LinkedPages $admin $loading '/admin/loading/[^/?]+' 'admin loading detail'
$warehouse = Open-Session 13 '/warehouse/login' '/warehouse'
foreach($path in @('/warehouse/inventory','/warehouse/inbound','/warehouse/outbound','/warehouse/loading-documents')) { $null = Read-Page $warehouse $path $path }
$portal = Open-Session 15 '/portal/login' '/portal'
$portalOrders = Read-Page $portal '/portal/orders' 'portal orders'
$null = Read-Page $portal '/portal/tracking' 'portal tracking'
Read-LinkedPages $portal $portalOrders '/portal/orders/[^/?]+/mark-label(?:\?|$)' 'portal mark label' 3
Write-Output 'Read-only production checks completed. No order, inventory or financial mutations submitted.'
