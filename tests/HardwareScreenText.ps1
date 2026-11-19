# The native hardware test sends a single image over stdin. Only recognized UI
# labels and the two fixed test markers leave this process. Frames stay in RAM.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$stream = [IO.MemoryStream]::new([Convert]::FromBase64String([Console]::ReadLine()))
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (!$engine) { throw 'Windows OCR is unavailable' }
$method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 } |
    Select-Object -First 1
function Wait-Result($operation, $resultType) {
    $task = $method.MakeGenericMethod($resultType).Invoke($null,@($operation))
    if (!$task.Wait(8000)) { throw 'Image decode timed out' }
    return $task.Result
}
$random = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($stream)
$decoder = Wait-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($random)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Wait-Result ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$work = $method.MakeGenericMethod([Windows.Media.Ocr.OcrResult]).Invoke($null,@($engine.RecognizeAsync($bitmap)))
if (!$work.Wait(8000)) { throw 'Recognition timed out' }
$labels = ConvertFrom-Json '{"\u641c\u7d22":"search","search":"search","spotlight":"search","\u8bbe\u7f6e":"settings","settings":"settings","\u901a\u7528":"general","general":"general","\u84dd\u7259":"bluetooth","bluetooth":"bluetooth","\u53d6\u6d88":"cancel","cancel":"cancel","\u5173\u4e8e\u672c\u673a":"about","\u5c4f\u5e55\u4f7f\u7528\u65f6\u95f4":"screen-time","\u672a\u627e\u5230\u7ed3\u679c":"no-results","583762":"pad-marker","926438":"phone-marker","\u540d\u79f0":"name","\u65ad\u5f00\u8fde\u63a5":"disconnect","\u5df2\u8fde\u63a5":"connected","lfc":"computer"}'
$found = @()
$extra = ConvertFrom-Json '{"\u5ffd\u7565\u6b64\u8bbe\u5907":"forget","\u5ffd\u7565\u8fd9\u4e2a\u8bbe\u5907":"forget","\u5ffd\u7565\u6b64\u88c5\u7f6e":"forget","\u8bbe\u5907\u7c7b\u578b":"device-type","\u5b8c\u6210":"done","lfc-ipad":"pad-name","lfc-iphonese":"phone-name"}'
foreach ($property in $extra.PSObject.Properties) { $labels | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value }
$labels | Add-Member -NotePropertyName (ConvertFrom-Json '"\u672a\u8fde\u63a5"') -NotePropertyValue 'not-connected'
$radioLabels=ConvertFrom-Json '{"\u6211\u7684\u8bbe\u5907":"my-devices","\u5176\u4ed6\u8bbe\u5907":"other-devices","\u5176\u5b83\u8bbe\u5907":"other-devices","\u8fde\u63a5":"connect","mydevices":"my-devices","otherdevices":"other-devices","notconnected":"not-connected","connected":"connected"}'
foreach ($property in $radioLabels.PSObject.Properties) { $labels | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value -Force }
function Match-Label($words) {
    $label = (($words.Text -join '').Trim() -replace '^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$','').ToLowerInvariant()
    $label = $label -replace '^q(?=\u641c\u7d22|search|\d{6}$)',''
    $label=$label -replace '[\u2013\u2014\u2010]','-'
    if ($label -match '^[qo0il1\u4e28\u25cb\u3007]{0,3}([\u641c\u635c\u8490][\u7d22\u7d20]|search)($|\u8bbe\u7f6e$)') {$label='search'}
    if (!$label -or !$labels.PSObject.Properties[$label]) { return }
    $first = $words[0].BoundingRect
    $last = $words[-1].BoundingRect
    [pscustomobject]@{label=$labels.$label; x=[Math]::Round(($first.X+$last.X+$last.Width)/2); y=[Math]::Round($first.Y+$first.Height/2)}
}
foreach ($line in $work.Result.Lines) {
    # iPad can place the sidebar and the detail view on the same OCR line.
    # Split only at large gaps so a longer phrase never becomes a search field.
    $group = @()
    foreach ($word in $line.Words) {
        if ($group.Count) {
            $previous=$group[-1].BoundingRect
            if ($word.BoundingRect.X-($previous.X+$previous.Width) -gt 1.25*$previous.Height) {
                $found+=@(Match-Label $group)
                $group=@()
            }
        }
        $group+=@($word)
    }
    if ($group.Count) { $found+=@(Match-Label $group) }
}
[Console]::WriteLine((ConvertTo-Json -InputObject $found -Compress))
