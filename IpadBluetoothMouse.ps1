$ErrorActionPreference = 'Stop'
$instanceMutex = New-Object Threading.Mutex($false, 'Local\IpadBluetoothMouse')
try { $ownsMutex = $instanceMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
if (-not $ownsMutex) {
    $instanceMutex.Dispose()
    [Console]::Error.WriteLine('Bluetooth is in use by another console.')
    exit 73
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$providerType = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceProvider,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
$providerResultType = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceProviderResult,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
$characteristicResultType = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattLocalCharacteristicResult,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
$descriptorResultType = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattLocalDescriptorResult,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
$notifyResultType = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattClientNotificationResult,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
$propertiesType = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicProperties,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
$protectionType = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattProtectionLevel,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Wait-WinRtOperation($operation, [Type]$resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.GetAwaiter().GetResult()
}

function Get-BluetoothUuid([int]$value) {
    [guid]('0000{0:x4}-0000-1000-8000-00805f9b34fb' -f $value)
}

function New-ByteBuffer([byte[]]$bytes) {
    [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($bytes)
}

function New-GattProvider([int]$uuid) {
    $result = Wait-WinRtOperation ($providerType::CreateAsync((Get-BluetoothUuid $uuid))) $providerResultType
    if ($result.Error -ne 'Success') { throw ('GATT service 0x{0:X4} failed: {1}' -f $uuid, $result.Error) }
    $result.ServiceProvider
}

function New-GattCharacteristic($service, [int]$uuid, $properties, [byte[]]$value, [switch]$public) {
    $parameters = New-Object 'Windows.Devices.Bluetooth.GenericAttributeProfile.GattLocalCharacteristicParameters,Windows.Devices.Bluetooth,ContentType=WindowsRuntime'
    $parameters.CharacteristicProperties = $properties
    if (-not $public) {
        $parameters.ReadProtectionLevel = $protectionType::EncryptionRequired
        $parameters.WriteProtectionLevel = $protectionType::EncryptionRequired
    }
    if ($null -ne $value) { $parameters.StaticValue = New-ByteBuffer $value }
    $result = Wait-WinRtOperation ($service.CreateCharacteristicAsync((Get-BluetoothUuid $uuid), $parameters)) $characteristicResultType
    if ($result.Error -ne 'Success') { throw ('GATT characteristic 0x{0:X4} failed: {1}' -f $uuid, $result.Error) }
    $result.Characteristic
}

function Get-UniquePeerClient($report, [string]$id) {
    if (!$id) { return }
    $matches = @($report.SubscribedClients | Where-Object {
        $_.Session.SessionStatus -eq 'Active' -and $_.Session.DeviceId.Id -ceq $id
    })
    if ($matches.Count -eq 1) { return $matches[0] }
}

function Get-PeerCatalog {
    $ids = @($mouseReport.SubscribedClients | Where-Object {
        $_.Session.SessionStatus -eq 'Active' -and $_.Session.DeviceId.Id
    } | ForEach-Object { $_.Session.DeviceId.Id })
    foreach ($known in @($script:peerHandles.Keys)) {
        if ($known -cnotin $ids) {
            $null = $script:peerHandles.Remove($known)
            if ($known -ceq $script:mousePeer) {
                $script:mousePeer = $null
                $script:explicitPeer = $true
            }
        }
    }
    foreach ($id in $ids) {
        if (!(Get-UniquePeerClient $mouseReport $id)) { continue }
        if (!$script:peerHandles.ContainsKey($id)) { $script:peerHandles[$id] = [Guid]::NewGuid().ToString('N') }
        [pscustomobject]@{
            id = $script:peerHandles[$id]
            keyboard = ($null -ne (Get-UniquePeerClient $keyboardReport $id))
            absolute = ($null -ne (Get-UniquePeerClient $absoluteReport $id))
        }
    }
}

function Select-InputPeer([string]$handle) {
    $null = @(Get-PeerCatalog)
    $id = $null
    if ($handle) {
        if ($handle -cnotmatch '^[a-f0-9]{32}$') { throw 'Invalid Bluetooth target.' }
        foreach ($peer in $script:peerHandles.GetEnumerator()) {
            if ($peer.Value -ceq $handle) { $id = $peer.Key; break }
        }
        if (!$id -or !(Get-UniquePeerClient $mouseReport $id)) { throw 'Bluetooth target disconnected.' }
    }
    Reset-PeerInput
    $script:mousePeer = $id
    $script:explicitPeer = $true
}

function Get-MouseClient {
    if ($script:explicitPeer) { return (Get-UniquePeerClient $mouseReport $script:mousePeer) }
    $clients = @($mouseReport.SubscribedClients | Where-Object { $_.Session.SessionStatus -eq 'Active' })
    if ($clients.Count -ne 1) { return }
    $id = $clients[0].Session.DeviceId.Id
    if (!$id) { return }
    $keyboards = @($keyboardReport.SubscribedClients | Where-Object { $_.Session.SessionStatus -eq 'Active' })
    if ($keyboards.Count -gt 1 -or ($keyboards.Count -eq 1 -and $keyboards[0].Session.DeviceId.Id -ne $id)) { return }
    if (!$script:mousePeer) { $script:mousePeer = $id }
    if ($id -eq $script:mousePeer) { return $clients[0] }
}

function Get-MatchingClient($report) {
    $mouse = Get-MouseClient
    if (!$mouse) { return }
    if ($script:explicitPeer) { return (Get-UniquePeerClient $report $script:mousePeer) }
    $clients = @($report.SubscribedClients | Where-Object { $_.Session.SessionStatus -eq 'Active' })
    if ($clients.Count -eq 1 -and $clients[0].Session.DeviceId.Id -eq $mouse.Session.DeviceId.Id) { return $clients[0] }
}

function Send-MouseReport([byte]$buttons, [int]$dx, [int]$dy, [int]$wheel) {
    $client = Get-MouseClient
    if (!$client) { throw 'A single matching mouse connection is required. Reconnect Bluetooth to switch devices.' }
    if ($buttons) { $script:relativeHeld = $client }
    Write-MouseReport $client $buttons $dx $dy $wheel
    if (!$buttons) { $script:relativeHeld = $null }
}

function Write-MouseReport($client, [byte]$buttons, [int]$dx, [int]$dy, [int]$wheel) {
    $payload = New-ByteBuffer ([byte[]]@($buttons, ($dx -band 255), ($dy -band 255), ($wheel -band 255)))
    $result = Wait-WinRtOperation ($mouseReport.NotifyValueAsync($payload, $client)) $notifyResultType
    if ($result.Status -ne 'Success') { throw "Mouse report failed: $($result.Status)." }
}

function Send-KeyboardReport([byte]$modifiers, [byte[]]$keys) {
    $client = Get-MatchingClient $keyboardReport
    if (!$client) { throw 'Keyboard and mouse must belong to the same single connected device.' }
    if ($modifiers -or $keys.Count) { $script:keyboardHeld = $client }
    Write-KeyboardReport $client $modifiers $keys
    if (!$modifiers -and !$keys.Count) { $script:keyboardHeld = $null }
}

function Write-KeyboardReport($client, [byte]$modifiers, [byte[]]$keys) {
    $bytes = [byte[]]@(0,0,0,0,0,0,0,0)
    $bytes[0] = $modifiers
    for ($i = 0; $i -lt $keys.Count; $i++) { $bytes[$i + 2] = $keys[$i] }
    $result = Wait-WinRtOperation ($keyboardReport.NotifyValueAsync((New-ByteBuffer $bytes), $client)) $notifyResultType
    if ($result.Status -ne 'Success') { throw "Keyboard report failed: $($result.Status)." }
}

function Get-AbsoluteClient {
    Get-MatchingClient $absoluteReport
}

function Write-AbsoluteReport($client, [int]$buttons, [int]$x, [int]$y) {
    $bytes = [byte[]]@($buttons, ($x -band 255), ($x -shr 8), ($y -band 255), ($y -shr 8))
    $result = Wait-WinRtOperation ($absoluteReport.NotifyValueAsync((New-ByteBuffer $bytes), $client)) $notifyResultType
    if ($result.Status -ne 'Success') { throw "Absolute report failed: $($result.Status)." }
}

function Reset-AbsoluteButtons {
    $held = $script:absoluteHeld
    if ($null -eq $held) { return }
    # Release only the client to which the down was sent, at its last position.
    if ($held.Client.Session.SessionStatus -eq 'Active') {
        Write-AbsoluteReport $held.Client 0 $held.X $held.Y
    }
    $script:absoluteHeld = $null
}

function Reset-PeerInput {
    # Each release belongs to the client that received down, even when selection is now ambiguous.
    $released = $true
    try { Reset-AbsoluteButtons } catch { $released = $false }
    try {
        if ($script:relativeHeld -and $script:relativeHeld.Session.SessionStatus -eq 'Active') {
            Write-MouseReport $script:relativeHeld 0 0 0 0
        }
        $script:relativeHeld = $null
    } catch { $released = $false }
    try {
        if ($script:keyboardHeld -and $script:keyboardHeld.Session.SessionStatus -eq 'Active') {
            Write-KeyboardReport $script:keyboardHeld 0 ([byte[]]@())
        }
        $script:keyboardHeld = $null
    } catch { $released = $false }
    if (!$released) { throw 'Unable to release all inputs on the previous Bluetooth target.' }
}

function Write-PeerStatus {
    $peers = @(Get-PeerCatalog)
    $mouse = Get-MouseClient
    $selected = $null
    if ($mouse) { $selected = $script:peerHandles[$mouse.Session.DeviceId.Id] }
    $status = @{
        peers = $peers
        selectedPeer = $selected
        keyboardActive = [int]($null -ne (Get-MatchingClient $keyboardReport))
        absoluteActive = [int]($null -ne (Get-AbsoluteClient))
    }
    [Console]::WriteLine('TARGETS: ' + (ConvertTo-Json $status -Compress -Depth 3))
}

function Send-AbsoluteReport([int]$buttons, [int]$x, [int]$y) {
    if ($buttons -lt 0 -or $buttons -gt 7 -or $x -lt 0 -or $x -gt 32767 -or $y -lt 0 -or $y -gt 32767) {
        throw 'Absolute report out of range.'
    }
    $client = Get-AbsoluteClient
    if ($null -eq $client) { throw 'Absolute and relative mouse reports require the same single active device.' }
    if ($script:absoluteHeld -and $script:absoluteHeld.Client.Session.DeviceId.Id -ne $client.Session.DeviceId.Id) {
        Reset-AbsoluteButtons
        throw 'Absolute pointer recipient changed.'
    }
    # Keep a release target even if notification delivery is interrupted before acknowledgement.
    if ($buttons) { $script:absoluteHeld = @{ Client=$client; X=$x; Y=$y } }
    Write-AbsoluteReport $client $buttons $x $y
    if (!$buttons) { $script:absoluteHeld = $null }
}

# Input 1 is the relative mouse, 2 the keyboard, and 3 the absolute mouse.
$descriptor = [byte[]]@(
    0x05,0x01, 0x09,0x02, 0xA1,0x01, 0x85,0x01, 0x09,0x01, 0xA1,0x00,
    0x05,0x09, 0x19,0x01, 0x29,0x03, 0x15,0x00, 0x25,0x01, 0x95,0x03, 0x75,0x01, 0x81,0x02,
    0x95,0x01, 0x75,0x05, 0x81,0x03,
    0x05,0x01, 0x09,0x30, 0x09,0x31, 0x09,0x38, 0x15,0x81, 0x25,0x7F, 0x75,0x08, 0x95,0x03,
    0x81,0x06, 0xC0, 0xC0,
    0x05,0x01, 0x09,0x06, 0xA1,0x01, 0x85,0x02,
    0x05,0x07, 0x19,0xE0, 0x29,0xE7, 0x15,0x00, 0x25,0x01,
    0x75,0x01, 0x95,0x08, 0x81,0x02,
    0x75,0x08, 0x95,0x01, 0x81,0x01,
    0x19,0x00, 0x29,0x65, 0x15,0x00, 0x25,0x65,
    0x75,0x08, 0x95,0x06, 0x81,0x00, 0xC0,
    0x05,0x01, 0x09,0x02, 0xA1,0x01, 0x85,0x03, 0x09,0x01, 0xA1,0x00,
    0x05,0x09, 0x19,0x01, 0x29,0x03, 0x15,0x00, 0x25,0x01,
    0x75,0x01, 0x95,0x03, 0x81,0x02, 0x75,0x05, 0x95,0x01, 0x81,0x03,
    0x05,0x01, 0x09,0x30, 0x09,0x31, 0x15,0x00, 0x26,0xFF,0x7F,
    0x75,0x10, 0x95,0x02, 0x81,0x02, 0xC0,0xC0
)

$hid = $null
$battery = $null
$hidAdvertising = $false
$batteryAdvertising = $false
$script:mousePeer = $null
$script:explicitPeer = $false
$script:peerHandles = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
$script:absoluteHeld = $null
$script:relativeHeld = $null
$script:keyboardHeld = $null
try {
    $hid = New-GattProvider 0x1812
    $null = New-GattCharacteristic $hid.Service 0x2A4A $propertiesType::Read ([byte[]]@(0x11,0x01,0x00,0x02))
    $null = New-GattCharacteristic $hid.Service 0x2A4B $propertiesType::Read $descriptor
    $null = New-GattCharacteristic $hid.Service 0x2A4C $propertiesType::WriteWithoutResponse $null -Public
    $reportProperties = $propertiesType::Read -bor $propertiesType::Notify
    $mouseReport = New-GattCharacteristic $hid.Service 0x2A4D $reportProperties ([byte[]]@(0,0,0,0))

    $reference = New-Object 'Windows.Devices.Bluetooth.GenericAttributeProfile.GattLocalDescriptorParameters,Windows.Devices.Bluetooth,ContentType=WindowsRuntime'
    $reference.StaticValue = New-ByteBuffer ([byte[]]@(1,1))
    $reference.ReadProtectionLevel = $protectionType::EncryptionRequired
    $desc = Wait-WinRtOperation ($mouseReport.CreateDescriptorAsync((Get-BluetoothUuid 0x2908), $reference)) $descriptorResultType
    if ($desc.Error -ne 'Success') { throw "HID report reference failed: $($desc.Error)." }

    $keyboardReport = New-GattCharacteristic $hid.Service 0x2A4D $reportProperties ([byte[]]@(0,0,0,0,0,0,0,0))
    $keyboardReference = New-Object 'Windows.Devices.Bluetooth.GenericAttributeProfile.GattLocalDescriptorParameters,Windows.Devices.Bluetooth,ContentType=WindowsRuntime'
    $keyboardReference.StaticValue = New-ByteBuffer ([byte[]]@(2,1))
    $keyboardReference.ReadProtectionLevel = $protectionType::EncryptionRequired
    $keyboardDesc = Wait-WinRtOperation ($keyboardReport.CreateDescriptorAsync((Get-BluetoothUuid 0x2908), $keyboardReference)) $descriptorResultType
    if ($keyboardDesc.Error -ne 'Success') { throw "Keyboard report reference failed: $($keyboardDesc.Error)." }

    $absoluteReport = New-GattCharacteristic $hid.Service 0x2A4D $reportProperties ([byte[]]@(0,0,0,0,0))
    $absoluteReference = New-Object 'Windows.Devices.Bluetooth.GenericAttributeProfile.GattLocalDescriptorParameters,Windows.Devices.Bluetooth,ContentType=WindowsRuntime'
    $absoluteReference.StaticValue = New-ByteBuffer ([byte[]]@(3,1))
    $absoluteReference.ReadProtectionLevel = $protectionType::EncryptionRequired
    $absoluteDesc = Wait-WinRtOperation ($absoluteReport.CreateDescriptorAsync((Get-BluetoothUuid 0x2908), $absoluteReference)) $descriptorResultType
    if ($absoluteDesc.Error -ne 'Success') { throw "Absolute pointer report reference failed: $($absoluteDesc.Error)." }

    $battery = New-GattProvider 0x180F
    $null = New-GattCharacteristic $battery.Service 0x2A19 $reportProperties ([byte[]]@(100)) -Public
    $advertisement = New-Object 'Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceProviderAdvertisingParameters,Windows.Devices.Bluetooth,ContentType=WindowsRuntime'
    $advertisement.IsConnectable = $true
    $advertisement.IsDiscoverable = $true
    $hid.StartAdvertising($advertisement)
    $hidAdvertising = $true
    $battery.StartAdvertising($advertisement)
    $batteryAdvertising = $true
    Start-Sleep -Seconds 2
    if ($hid.AdvertisementStatus -notin @('Started', 'StartedWithoutAllAdvertisementData')) {
        throw "Windows could not advertise the mouse: $($hid.AdvertisementStatus)."
    }

    [Console]::WriteLine("READY: Pair $env:COMPUTERNAME from device Settings > Bluetooth.")
    [Console]::WriteLine('Commands: status, peer-select HANDLE, peer-clear, move X Y, click, scroll N, report B X Y W, absolute B X Y, absolute-release, keys MODIFIER [KEYS], quit.')
    while ($null -ne ($line = [Console]::ReadLine())) {
        $parts = $line.Trim() -split '\s+'
        try {
            switch ($parts[0]) {
                'status' { Write-PeerStatus }
                'peer-select' {
                    if ($parts.Count -ne 2) { throw 'Usage: peer-select HANDLE' }
                    Select-InputPeer $parts[1]
                    Write-PeerStatus
                }
                'peer-release' {
                    Reset-PeerInput
                    [Console]::WriteLine('OK: peer-release')
                }
                'peer-clear' {
                    Select-InputPeer $null
                    Write-PeerStatus
                }
                'move' {
                    if ($parts.Count -ne 3) { throw 'Usage: move X Y' }
                    $x, $y = [int]$parts[1], [int]$parts[2]
                    if ([Math]::Abs($x) -gt 127 -or [Math]::Abs($y) -gt 127) { throw 'Movement must be within -127 to 127.' }
                    Send-MouseReport 0 $x $y 0
                    [Console]::WriteLine('OK: move')
                }
                'click' {
                    Send-MouseReport 1 0 0 0
                    Start-Sleep -Milliseconds 70
                    Send-MouseReport 0 0 0 0
                    [Console]::WriteLine('OK: click')
                }
                'scroll' {
                    if ($parts.Count -ne 2) { throw 'Usage: scroll N' }
                    $wheel = [int]$parts[1]
                    if ([Math]::Abs($wheel) -gt 127) { throw 'Scroll must be within -127 to 127.' }
                    Send-MouseReport 0 0 0 $wheel
                    [Console]::WriteLine('OK: scroll')
                }
                'report' {
                    if ($parts.Count -ne 5) { throw 'Usage: report BUTTONS X Y WHEEL' }
                    $buttons, $x, $y, $wheel = [int]$parts[1], [int]$parts[2], [int]$parts[3], [int]$parts[4]
                    if ($buttons -lt 0 -or $buttons -gt 7) { throw 'Buttons must be within 0 to 7.' }
                    if ([Math]::Abs([long]$x) -gt 127 -or [Math]::Abs([long]$y) -gt 127 -or [Math]::Abs([long]$wheel) -gt 127) {
                        throw 'Movement and wheel must be within -127 to 127.'
                    }
                    Send-MouseReport ([byte]$buttons) $x $y $wheel
                    [Console]::WriteLine('OK: report')
                }
                'keys' {
                    if ($parts.Count -lt 2 -or $parts.Count -gt 8) { throw 'Usage: keys MODIFIER [UP TO 6 HID USAGES]' }
                    $modifiers = [int]$parts[1]
                    if ($modifiers -lt 0 -or $modifiers -gt 255) { throw 'Modifiers must be within 0 to 255.' }
                    $keys = @()
                    for ($i = 2; $i -lt $parts.Count; $i++) {
                        $key = [int]$parts[$i]
                        if ($key -lt 4 -or $key -gt 101) { throw 'Key usage must be within 4 to 101.' }
                        $keys += [byte]$key
                    }
                    Send-KeyboardReport ([byte]$modifiers) ([byte[]]$keys)
                    [Console]::WriteLine('OK: keys')
                }
                'absolute' {
                    if ($parts.Count -ne 4) { throw 'Usage: absolute BUTTONS X Y' }
                    Send-AbsoluteReport ([int]$parts[1]) ([int]$parts[2]) ([int]$parts[3])
                    [Console]::WriteLine('OK: absolute')
                }
                'absolute-release' {
                    Reset-AbsoluteButtons
                    [Console]::WriteLine('OK: absolute-release')
                }
                'quit' { return }
                default { [Console]::WriteLine('ERROR: unknown command.') }
            }
        } catch {
            [Console]::WriteLine("ERROR: $($_.Exception.Message)")
        }
    }
} finally {
    try { Reset-PeerInput } catch {}
    if ($batteryAdvertising) { $battery.StopAdvertising() }
    if ($hidAdvertising) { $hid.StopAdvertising() }
    if ($ownsMutex) { $instanceMutex.ReleaseMutex() }
    $instanceMutex.Dispose()
}
