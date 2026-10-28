# Renderiza assets/social.png (1280x640) y assets/banner.png (1280x320) desde card.html con Chrome sin interfaz.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$url = ([System.Uri](Join-Path $here "card.html")).AbsoluteUri
$profile = Join-Path $env:TEMP ("card-" + [guid]::NewGuid())
foreach ($k in @(@{ n = "social"; h = 640 }, @{ n = "banner"; h = 320 })) {
    $out = Join-Path (Split-Path -Parent $here) "$($k.n).png"
    $args = @("--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--allow-file-access-from-files", "--virtual-time-budget=2000", "--user-data-dir=`"$profile`"", "--window-size=1280,$($k.h)", "--screenshot=`"$out`"", "$url#$($k.n)")
    Start-Process -FilePath $chrome -ArgumentList $args -Wait -NoNewWindow -RedirectStandardError (Join-Path $env:TEMP "card-err.txt")
    Write-Output "$out"
}
Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue
