$ErrorActionPreference = 'Stop'

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

function Send-MouseReport([byte]$buttons, [int]$dx, [int]$dy, [int]$wheel) {
    $clients = @($mouseReport.SubscribedClients | Where-Object { $_.Session.SessionStatus -eq 'Active' })
    if ($clients.Count -ne 1) { throw "Expected one active iPad mouse connection, found $($clients.Count)." }
    $payload = New-ByteBuffer ([byte[]]@($buttons, ($dx -band 255), ($dy -band 255), ($wheel -band 255)))
    $result = Wait-WinRtOperation ($mouseReport.NotifyValueAsync($payload, $clients[0])) $notifyResultType
    if ($result.Status -ne 'Success') { throw "Mouse report failed: $($result.Status)." }
}

# One HID input report (ID 1): buttons, relative X/Y and vertical wheel.
$descriptor = [byte[]]@(
    0x05,0x01, 0x09,0x02, 0xA1,0x01, 0x85,0x01, 0x09,0x01, 0xA1,0x00,
    0x05,0x09, 0x19,0x01, 0x29,0x03, 0x15,0x00, 0x25,0x01, 0x95,0x03, 0x75,0x01, 0x81,0x02,
    0x95,0x01, 0x75,0x05, 0x81,0x03,
    0x05,0x01, 0x09,0x30, 0x09,0x31, 0x09,0x38, 0x15,0x81, 0x25,0x7F, 0x75,0x08, 0x95,0x03,
    0x81,0x06, 0xC0, 0xC0
)

$hid = $null
$battery = $null
$hidAdvertising = $false
$batteryAdvertising = $false
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

    [Console]::WriteLine("READY: Pair $env:COMPUTERNAME from iPad Settings > Bluetooth.")
    [Console]::WriteLine('Commands: status, move X Y, click, scroll N, quit.')
    while ($null -ne ($line = [Console]::ReadLine())) {
        $parts = $line.Trim() -split '\s+'
        try {
            switch ($parts[0]) {
                'status' {
                    $subscribers = @($mouseReport.SubscribedClients)
                    $active = @($subscribers | Where-Object { $_.Session.SessionStatus -eq 'Active' }).Count
                    [Console]::WriteLine("STATUS: $($hid.AdvertisementStatus); subscribers: $($subscribers.Count); active mouse connections: $active.")
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
                'quit' { return }
                default { [Console]::WriteLine('ERROR: unknown command.') }
            }
        } catch {
            [Console]::WriteLine("ERROR: $($_.Exception.Message)")
        }
    }
} finally {
    if ($batteryAdvertising) { $battery.StopAdvertising() }
    if ($hidAdvertising) { $hid.StopAdvertising() }
}
