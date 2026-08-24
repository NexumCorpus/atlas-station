Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$out = "E:\atlas-station\.atlas\ui-capture"
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
$p = Join-Path $out "screen-$ts.png"
$bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "SAVED:$p"
