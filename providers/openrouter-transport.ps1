$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$envelope = [Console]::In.ReadToEnd() | ConvertFrom-Json
$handler = [System.Net.Http.HttpClientHandler]::new()
$client = [System.Net.Http.HttpClient]::new($handler)
$request = $null
$response = $null

try {
  $request = [System.Net.Http.HttpRequestMessage]::new(
    [System.Net.Http.HttpMethod]::Post,
    [string]$envelope.url
  )
  $request.Content = [System.Net.Http.StringContent]::new(
    [string]$envelope.body,
    [System.Text.Encoding]::UTF8,
    'application/json'
  )
  foreach ($property in $envelope.headers.PSObject.Properties) {
    if ($property.Name -ieq 'Content-Type') { continue }
    [void]$request.Headers.TryAddWithoutValidation($property.Name, [string]$property.Value)
  }
  $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
  $maxResponseBytes = [Math]::Max(1048576, [Math]::Min(67108864, [long]$envelope.maxResponseBytes))
  if ($response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength.Value -gt $maxResponseBytes) {
    throw "OpenRouter response exceeds $maxResponseBytes bytes"
  }
  $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
  $memory = [System.IO.MemoryStream]::new()
  $buffer = [byte[]]::new(65536)
  try {
    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      if ($memory.Length + $read -gt $maxResponseBytes) { throw "OpenRouter response exceeds $maxResponseBytes bytes" }
      $memory.Write($buffer, 0, $read)
    }
    $responseBytes = $memory.ToArray()
  } finally {
    $memory.Dispose()
    $stream.Dispose()
  }
  [Console]::Out.Write((@{
    status = [int]$response.StatusCode
    statusText = [string]$response.ReasonPhrase
    bodyB64 = [Convert]::ToBase64String($responseBytes)
    admitted = $true
  } | ConvertTo-Json -Compress -Depth 4))
} catch {
  if ($response) {
    [Console]::Out.Write((@{
      status = [int]$response.StatusCode
      statusText = [string]$response.ReasonPhrase
      bodyB64 = ''
      admitted = $true
      transportError = [string]$_.Exception.Message
    } | ConvertTo-Json -Compress -Depth 4))
  } else {
    throw
  }
} finally {
  if ($request) { $request.Dispose() }
  if ($response) { $response.Dispose() }
  $client.Dispose()
  $handler.Dispose()
}
