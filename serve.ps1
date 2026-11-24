$root = $PSScriptRoot; $port = 8080
$mime = @{ '.html'='text/html'; '.js'='text/javascript'; '.css'='text/css'; '.json'='application/json'; '.webp'='image/webp'; '.png'='image/png'; '.txt'='text/plain' }
$l = New-Object System.Net.HttpListener
$l.Prefixes.Add("http://localhost:$port/")
$l.Start(); "Serving $root on http://localhost:$port/  (Ctrl+C to stop)"
while ($l.IsListening) {
  $c = $l.GetContext()
  $rel = [Uri]::UnescapeDataString($c.Request.Url.AbsolutePath.TrimStart('/'))
  if ($rel -eq '') { $rel = 'spike4.html' }
  $p = Join-Path $root $rel
  if (($rel -notmatch '\.\.') -and (Test-Path $p -PathType Leaf)) {
    $ext = [IO.Path]::GetExtension($p).ToLower()
    $c.Response.ContentType = $(if ($mime[$ext]) { $mime[$ext] } else { 'application/octet-stream' })
    $c.Response.Headers.Add('Cache-Control','no-store')
    $b = [IO.File]::ReadAllBytes($p)
    $c.Response.ContentLength64 = $b.Length
    $c.Response.OutputStream.Write($b,0,$b.Length)
  } else { $c.Response.StatusCode = 404 }
  $c.Response.Close()
}
