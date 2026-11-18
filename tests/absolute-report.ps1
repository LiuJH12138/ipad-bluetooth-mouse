$ErrorActionPreference = 'Stop'
# Load the serializer and routing functions, without advertising a Bluetooth device.
$file = Join-Path (Split-Path $PSScriptRoot) 'IpadBluetoothMouse.ps1'
$errors = $null; $tokens = $null
$scriptAst = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
if ($errors) { throw $errors[0] }
$names = 'Get-AbsoluteClient','Write-AbsoluteReport','Reset-AbsoluteButtons','Send-AbsoluteReport'
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
