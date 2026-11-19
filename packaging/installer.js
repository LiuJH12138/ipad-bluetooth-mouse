'use strict';
// Generate a per-user MSI manifest from a clean, allowlisted staging directory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [stage, output, icon] = process.argv.slice(2);
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
function id(s) { return 'i' + crypto.createHash('sha256').update(s).digest('hex').slice(0, 32); }
function guid(s) {
  const hex = id('component/' + s).slice(1);
  return [hex.slice(0,8), hex.slice(8,12), '5'+hex.slice(13,16), 'a'+hex.slice(17,20),hex.slice(20)].join('-');
}
const components = [];
function directory(relative) {
  const content = [];
  for (const entry of fs.readdirSync(path.join(stage, relative), { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      content.push(`<Directory Id="${id('dir/'+name)}" Name="${xml(entry.name)}">${directory(name)}</Directory>`);
      continue;
    }
    if (!entry.isFile()) throw new Error('Unexpected staging entry: ' + name);
    const key = id(name);
    components.push(key);
    const fileId = entry.name === 'iPadControlConsole.exe' ? 'AppExe' : id('file/'+name);
    content.push(`<Component Id="${key}" Guid="${guid(name)}" Win64="yes">
      <RegistryValue Root="HKCU" Key="Software\\LiuJH12138\\iPadControlConsole\\Files" Name="${key}" Type="integer" Value="1" KeyPath="yes"/>
      <File Id="${fileId}" Name="${xml(entry.name)}" Source="${xml(path.join(stage,name))}"/>
      </Component>`);
  }
  const key=id('cleanup/'+relative);
  components.push(key);
  content.push(`<Component Id="${key}" Guid="${guid('cleanup/'+relative)}" Win64="yes">
      <RegistryValue Root="HKCU" Key="Software\\LiuJH12138\\iPadControlConsole\\Directories" Name="${key}" Type="integer" Value="1" KeyPath="yes"/>
      <RemoveFolder Id="${id('remove/'+relative)}" On="uninstall"/>
    </Component>`);
  return content.join('\n');
}
const tree = directory('');
const manifest = `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
 <Product Id="*" UpgradeCode="5CC3C449-CC44-4B5E-B6B6-0E930FBAB762" Name="iPhone 与 iPad 控制台 1.6.0" Manufacturer="LiuJH12138" Version="1.6.0" Language="2052" Codepage="936">
  <Package InstallerVersion="500" InstallScope="perUser" Platform="x64" Compressed="yes" SummaryCodepage="936"/>
  <MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="已安装更新版本的 iPad 控制台。"/>
  <MediaTemplate EmbedCab="yes" CompressionLevel="high"/>
  <Icon Id="ConsoleIcon" SourceFile="${xml(icon)}"/><Property Id="ARPPRODUCTICON" Value="ConsoleIcon"/>
  <Property Id="ARPURLINFOABOUT" Value="https://github.com/LiuJH12138/ipad-bluetooth-mouse"/>
  <Property Id="INSTALLDIR" Secure="yes">
    <RegistrySearch Id="ExistingInstallDirectory" Root="HKCU" Key="Software\\LiuJH12138\\iPadControlConsole" Name="InstallDirectory" Type="raw" Win64="yes"/>
  </Property>
  <Property Id="WIXUI_INSTALLDIR" Value="INSTALLDIR"/>
  <Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOXTEXT" Value="启动 iPhone 与 iPad 控制台"/>
  <Property Id="WIXUI_EXITDIALOGOPTIONALCHECKBOX" Value="1"/>
  <CustomAction Id="LaunchConsole" FileKey="AppExe" ExeCommand="" Return="asyncNoWait" Impersonate="yes"/>
  <UIRef Id="WixUI_InstallDir"/>
  <UI>
    <Publish Dialog="WelcomeDlg" Control="Next" Event="NewDialog" Value="InstallDirDlg" Order="2">NOT Installed</Publish>
    <Publish Dialog="InstallDirDlg" Control="Back" Event="NewDialog" Value="WelcomeDlg" Order="2">1</Publish>
    <Publish Dialog="ExitDialog" Control="Finish" Event="DoAction" Value="LaunchConsole" Order="1">WIXUI_EXITDIALOGOPTIONALCHECKBOX = "1" AND NOT Installed AND ACTION = "INSTALL" AND UILevel = 5</Publish>
  </UI>
  <WixVariable Id="WixUIDialogBmp" Value="${xml(path.join(path.dirname(output),'welcome.bmp'))}"/>
  <WixVariable Id="WixUIBannerBmp" Value="${xml(path.join(path.dirname(output),'banner.bmp'))}"/>
  <Directory Id="TARGETDIR" Name="SourceDir">
    <Directory Id="LocalAppDataFolder"><Directory Id="INSTALLDIR" Name="iPadControlConsole">${tree}</Directory></Directory>
    <Directory Id="ProgramMenuFolder"><Component Id="AppShortcut" Guid="A1DBB413-A167-444D-A58C-430CD09D7D5C" Win64="yes">
      <Shortcut Id="OpenApp" Name="iPad 控制台" Target="[INSTALLDIR]iPadControlConsole.exe" WorkingDirectory="INSTALLDIR" Icon="ConsoleIcon"/>
      <RegistryValue Root="HKCU" Key="Software\\LiuJH12138\\iPadControlConsole" Name="StartMenuShortcut" Type="integer" Value="1" KeyPath="yes"/>
      <RegistryValue Root="HKCU" Key="Software\\LiuJH12138\\iPadControlConsole" Name="InstallDirectory" Type="string" Value="[INSTALLDIR]"/>
    </Component></Directory>
  </Directory>
  <Feature Id="App" Title="iPad 控制台" Level="1"><ComponentRef Id="AppShortcut"/>${components.map(c=>`<ComponentRef Id="${c}"/>`).join('')}</Feature>
 </Product>
</Wix>`;
fs.writeFileSync(output, manifest);
