$ErrorActionPreference = 'Stop'
# Load the serializer and routing functions, without advertising a Bluetooth device.
$file = Join-Path (Split-Path $PSScriptRoot) 'IpadBluetoothMouse.ps1'
$errors = $null; $tokens = $null
$scriptAst = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
if ($errors) { throw $errors[0] }
$names = 'Get-PeerCatalog','Select-InputPeer','Get-UniquePeerClient','Reset-PeerInput','Write-MouseReport','Write-KeyboardReport','Send-MouseReport','Send-KeyboardReport','Get-MouseClient','Get-MatchingClient','Get-AbsoluteClient','Write-AbsoluteReport','Reset-AbsoluteButtons','Send-AbsoluteReport'
foreach ($statement in $scriptAst.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.FunctionDefinitionAst] -and $statement.Name -in $names) {
        . ([scriptblock]::Create($statement.Extent.Text))
    }
}
function New-ByteBuffer([byte[]]$bytes) { return ,$bytes }
function Wait-WinRtOperation($op, $type) { return $op }
function Client($id) { [pscustomobject]@{Session=@{SessionStatus='Active'; DeviceId=@{Id=$id}}} }
function Assert-Equal($expected,$actual) { if ($expected -ne $actual) { throw "Expected $expected, got $actual" } }
$a = Client 'A'; $b = Client 'B'
$mouseReport = @{SubscribedClients=@($a)}
$absoluteReport = [pscustomobject]@{SubscribedClients=@($a)}
$calls = New-Object 'System.Collections.Generic.List[string]'
$absoluteReport | Add-Member -MemberType ScriptMethod -Name NotifyValueAsync -Value {
    param($buf,$recipient)
    $calls.Add($recipient.Session.DeviceId.Id + ' ' + [BitConverter]::ToString($buf))
    return @{Status='Success'}
}
Reset-AbsoluteButtons
Assert-Equal 0 $calls.Count
Send-AbsoluteReport 6 4660 32566
Assert-Equal 'A 06-34-12-36-7F' $calls[0]
$absoluteReport.SubscribedClients = @($a,$b)
Assert-Equal $null (Get-AbsoluteClient)
Reset-AbsoluteButtons
Assert-Equal 'A 00-34-12-36-7F' $calls[1]
Reset-AbsoluteButtons
Assert-Equal 2 $calls.Count
$absoluteReport.SubscribedClients = @($b)
Assert-Equal $null (Get-AbsoluteClient)
# A second phone can become the only subscriber between status polls.
$mouseReport.SubscribedClients = @($b)
Assert-Equal $null (Get-MouseClient)
Assert-Equal $null (Get-AbsoluteClient)
Assert-Equal $null (Get-MatchingClient @{SubscribedClients=@($b)})
# A fresh Bluetooth connection deliberately binds the new recipient.
$script:mousePeer = $null
Assert-Equal 'B' (Get-MouseClient).Session.DeviceId.Id
Assert-Equal 'B' (Get-AbsoluteClient).Session.DeviceId.Id
Assert-Equal $null (Get-MatchingClient @{SubscribedClients=@($a)})
Assert-Equal $null (Get-MatchingClient @{SubscribedClients=@($a,$b)})
$keyboardReport = @{SubscribedClients=@($b,$a)}
Assert-Equal $null (Get-MouseClient)
Assert-Equal $null (Get-AbsoluteClient)
$keyboardReport.SubscribedClients = @($a)
Assert-Equal $null (Get-MouseClient)

# Two connected hosts share the same reports; each notification targets the explicitly selected client.
$mouseReport = [pscustomobject]@{SubscribedClients=@($a,$b)}
$keyboardReport = [pscustomobject]@{SubscribedClients=@($a,$b)}
$absoluteReport.SubscribedClients=@($a,$b)
foreach ($report in $mouseReport,$keyboardReport) {
    $report | Add-Member -MemberType ScriptMethod -Name NotifyValueAsync -Value {
        param($buf,$recipient)
        $calls.Add($recipient.Session.DeviceId.Id + ' ' + [BitConverter]::ToString($buf))
        return @{Status='Success'}
    }
}
$script:peerHandles = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
$peers = @(Get-PeerCatalog)
Assert-Equal 2 $peers.Count
Assert-Equal 2 @($peers.id | Select-Object -Unique).Count
Assert-Equal $true ($peers[0].id -cmatch '^[a-f0-9]{32}$')
$peerA = $script:peerHandles['A']
$peerB = $script:peerHandles['B']
Select-InputPeer $peerA
$calls.Clear()
Send-MouseReport 1 0 0 0
Send-KeyboardReport 0 @(4)
Send-AbsoluteReport 1 100 200
Select-InputPeer $peerB
Assert-Equal 6 $calls.Count
Assert-Equal 0 @($calls | Where-Object { $_ -notlike 'A *' }).Count
Send-AbsoluteReport 0 222 333
Assert-Equal 'B 00-DE-00-4D-01' $calls[6]
Assert-Equal $null (Get-MatchingClient @{SubscribedClients=@($a)})
Select-InputPeer $null
Assert-Equal $null (Get-MouseClient)
$mouseReport.SubscribedClients = @($a)
Assert-Equal $null (Get-MouseClient)
Select-InputPeer $peerA
$mouseReport.SubscribedClients = @($b)
$null = @(Get-PeerCatalog)
Assert-Equal $null (Get-MouseClient)
$threw = $false
try { Select-InputPeer $peerA } catch { $threw = $true }
Assert-Equal $true $threw
