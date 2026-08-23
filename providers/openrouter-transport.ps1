$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$envelope = [Console]::In.ReadToEnd() | ConvertFrom-Json
$handler = [System.Net.Http.HttpClientHandler]::new()
$client = [System.Net.Http.HttpClient]::new($handler)

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
  $response = $client.SendAsync($request).GetAwaiter().GetResult()
  $responseBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  [Console]::Out.Write((@{
    status = [int]$response.StatusCode
    statusText = [string]$response.ReasonPhrase
    body = $responseBody
  } | ConvertTo-Json -Compress -Depth 4))
} finally {
  if ($request) { $request.Dispose() }
  if ($response) { $response.Dispose() }
  $client.Dispose()
  $handler.Dispose()
}
