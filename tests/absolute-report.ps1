$ErrorActionPreference = 'Stop'
# Load the serializer and routing functions, without advertising a Bluetooth device.
$file = Join-Path (Split-Path $PSScriptRoot) 'IpadBluetoothMouse.ps1'
$errors = $null; $tokens = $null
$scriptAst = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
if ($errors) { throw $errors[0] }
$names = 'Get-PeerCatalog','Select-InputPeer','Get-UniquePeerClient','Reset-PeerInput','Write-MouseReport','Write-KeyboardReport','Send-MouseReport','Send-KeyboardReport','Get-MouseClient','Get-MatchingClient','Get-AbsoluteClient','Write-AbsoluteReport','Reset-AbsoluteButtons','Send-AbsoluteReport','Update-Subscriptions'
$names += 'Test-CurrentSubscription','Assert-InputRoute','Write-InputAcknowledgement'
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
$script:peerHandles = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
$script:peerClients = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
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
$script:peerClients = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
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

# A device can unsubscribe and reconnect with the same Windows device ID
# without ever disappearing from an externally polled snapshot.
function Write-PeerStatus($prefix) { Assert-Equal CHANGED $prefix }
$peerB = $script:peerHandles['B']
Select-InputPeer $peerB
$script:keyboardGeneration = 2
$script:readyKeyboards = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$null = $script:readyKeyboards.Add('B')
Update-Subscriptions @{Any=$true; Mouse=@(); Keyboard=@('B'); Absolute=@()}
Assert-Equal 3 $script:keyboardGeneration
$threw = $false
try { Assert-InputRoute $peerB '2' } catch { $threw = $true }
Assert-Equal $true $threw
Assert-InputRoute $peerB '3'
$calls.Clear()
$script:failNeutral = $true
$keyboardReport | Add-Member -Force -MemberType ScriptMethod -Name NotifyValueAsync -Value {
    param($buf,$recipient)
    $calls.Add($recipient.Session.DeviceId.Id + ' ' + [BitConverter]::ToString($buf))
    if ($script:failNeutral) { return @{Status='Unreachable'} }
    return @{Status='Success'}
}
$threw = $false
try { Send-KeyboardReport 2 @(4) } catch { $threw = $true }
Assert-Equal $true $threw
Assert-Equal 1 $calls.Count
Assert-Equal 'B 00-00-00-00-00-00-00-00' $calls[0]
$script:failNeutral = $false
Send-KeyboardReport 2 @(4)
Assert-Equal 3 $calls.Count
Assert-Equal 'B 00-00-00-00-00-00-00-00' $calls[1]
Assert-Equal 'B 02-00-04-00-00-00-00-00' $calls[2]
Update-Subscriptions @{Any=$true; Mouse=@('B'); Keyboard=@(); Absolute=@()}
$new = @(Get-PeerCatalog)
Assert-Equal $null (Get-MouseClient)
Assert-Equal 1 $new.Count
if ($new[0].id -ceq $peerB) { throw 'A reconnected mouse retained its old handle.' }

# Windows may expose a renewed object under the same DeviceId before delivering
# the change callback. Even in that window a pending report must keep its recipient.
Select-InputPeer $new[0].id
$replacement = Client 'B'
$script:wrongDelivery = 0
foreach ($report in $mouseReport,$keyboardReport,$absoluteReport) {
    $report.SubscribedClients = @($replacement)
    $report | Add-Member -Force -MemberType ScriptMethod -Name NotifyValueAsync -Value {
        param($buf,$recipient)
        if ([object]::ReferenceEquals($recipient,$replacement)) { $script:wrongDelivery++ }
        @{Status='Success'}
    }
}
Select-InputPeer $new[0].id
Send-MouseReport 1 0 0 0
Send-KeyboardReport 2 @(4)
Send-AbsoluteReport 1 100 200
Reset-PeerInput
Assert-Equal 0 $script:wrongDelivery

# An old client can still say Active while rejecting notifications after a
# resubscription. It cannot block selection indefinitely, or redirect its release.
Send-MouseReport 1 0 0 0
Send-KeyboardReport 2 @(4)
Send-AbsoluteReport 1 100 200
foreach ($report in $mouseReport,$keyboardReport,$absoluteReport) {
    $report | Add-Member -Force -MemberType ScriptMethod -Name NotifyValueAsync -Value {
        param($buf,$recipient)
        if ([object]::ReferenceEquals($recipient,$replacement)) { $script:wrongDelivery++ }
        @{Status='Unreachable'}
    }
}
Update-Subscriptions @{Any=$true; Mouse=@('B'); Keyboard=@('B'); Absolute=@('B')}
$current = @(Get-PeerCatalog)
Select-InputPeer $current[0].id
Assert-Equal 0 $script:wrongDelivery

# Absolute-only churn discovered during notification precedes its acknowledgement.
function Write-PeerStatus($prefix) { [Console]::WriteLine($prefix) }
$subscriptions = New-Object PSObject
$subscriptions | Add-Member -MemberType ScriptMethod -Name Drain -Value {
    @{Any=$true; Mouse=@(); Keyboard=@(); Absolute=@('B')}
}
$saved = [Console]::Out
$capture = New-Object IO.StringWriter
try {
    [Console]::SetOut($capture)
    Write-InputAcknowledgement 'absolute'
} finally { [Console]::SetOut($saved) }
Assert-Equal ("CHANGED" + [Environment]::NewLine + "OK: absolute" + [Environment]::NewLine) ($capture.ToString())
$capture.Dispose()
$threw = $false
try { Assert-InputRoute $current[0].id '3' } catch { $threw = $true }
Assert-Equal $true $threw
