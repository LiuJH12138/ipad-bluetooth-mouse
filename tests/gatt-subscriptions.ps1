param([switch]$CheckRegistration)
$ErrorActionPreference = 'Stop'
$worker = Join-Path (Split-Path $PSScriptRoot) 'IpadBluetoothMouse.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($worker,[ref]$tokens,[ref]$errors)
if ($errors) { throw $errors[0] }
$definition = $ast.EndBlock.Statements | Where-Object { $_.Name -eq 'Import-GattSubscriptions' }
if (!$definition) { throw 'Missing native subscription watcher.' }
. ([scriptblock]::Create($definition.Extent.Text))
Import-GattSubscriptions (Join-Path (Split-Path $PSScriptRoot) 'lib/GattSubscriptions.cs')
function Ids([string[]]$ids) {
    $set = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($id in $ids) { $null = $set.Add($id) }
    return ,$set
}
$affected = Ids @()
[GattSubscriptions]::Record((Ids @('A','B')),(Ids @('A')),$affected)
[GattSubscriptions]::Record((Ids @('A')),(Ids @('A','B')),$affected)
if (!$affected.SetEquals([string[]]@('B'))) { throw 'A stable peer was invalidated or a reconnected one was missed.' }
$affected.Clear()
[GattSubscriptions]::Record((Ids @('A','B')),(Ids @('A','B')),$affected)
if (!$affected.SetEquals([string[]]@('A','B'))) { throw 'Coalesced subscription events retained an unproven binding.' }

if ($CheckRegistration) {
    # Optional hardware integration smoke. The private service is never advertised.
    # It creates no HID characteristics, sends no reports and never accepts a peer.
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $providerType = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceProvider,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
    $resultType = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattServiceProviderResult,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
    $characteristicType = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattLocalCharacteristicResult,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
    $properties = [Windows.Devices.Bluetooth.GenericAttributeProfile.GattCharacteristicProperties,Windows.Devices.Bluetooth,ContentType=WindowsRuntime]
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    $definition = $ast.EndBlock.Statements | Where-Object { $_.Name -eq 'Wait-WinRtOperation' }
    . ([scriptblock]::Create($definition.Extent.Text))
    $result = Wait-WinRtOperation ($providerType::CreateAsync([Guid]::NewGuid())) $resultType
    if ($result.Error -ne 'Success') { throw ('Private service registration: ' + $result.Error) }
    $service = $result.ServiceProvider
    $reports = foreach ($index in 1..3) {
        $settings = New-Object 'Windows.Devices.Bluetooth.GenericAttributeProfile.GattLocalCharacteristicParameters,Windows.Devices.Bluetooth,ContentType=WindowsRuntime'
        $settings.CharacteristicProperties = $properties::Notify
        $created = Wait-WinRtOperation ($service.Service.CreateCharacteristicAsync([Guid]::NewGuid(),$settings)) $characteristicType
        if ($created.Error -ne 'Success') { throw ('Private characteristic: ' + $created.Error) }
        $created.Characteristic
    }
    $watcher = [GattSubscriptions]::new($reports[0],$reports[1],$reports[2])
    try {
        if ($watcher.Drain().Any) { throw 'Unexpected subscriber on private service.' }
        if ($service.AdvertisementStatus -ne 'Created') { throw ('Unexpected advertisement status: ' + $service.AdvertisementStatus) }
        'WinRT event registration succeeded without advertising.'
    } finally { $watcher.Dispose() }
}
