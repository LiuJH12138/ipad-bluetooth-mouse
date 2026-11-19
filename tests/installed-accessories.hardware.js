// Opt-in installed-device acceptance. All coordinates come from the current USB frame.
function installedAccessories({guard,labels,clickLabel,strokes,scrollPanel,readSwitchShape,report,only,note,waitFor,sleep}) {
  const aliases = {
    iPad: {text:'LFC - iPad', label:'pad-name'},
    iPhone: {text:'LFC - iPhone SE', label:'phone-name'}
  };
  const inspected = new Map();
  const original = new Map();
  const disconnectable = new Set();
  const confirmedNames = new Set();
  const names = ['computer','pad-name','phone-name'];
  function content(page,device) {
    return device.family==='iPad' ? page.filter(hit=>hit.x>usbCanvas.width*.37) : page;
  }
  function title(page) {
    return page.filter(hit=>names.includes(hit.label) && hit.y<usbCanvas.height*.135)
      .sort((a,b)=>a.y-b.y)[0];
  }
  function details(page,device) {
    const pane=content(page,device);
    return title(pane) && pane.some(hit=>['forget','disconnect','device-type'].includes(hit.label));
  }
  function describeRowIcon(frame,centerY) {
    const {width,height,data}=frame;
    const left=Math.round(width*.88), top=Math.max(0,Math.round(centerY-width*.043));
    const right=width-1,bottom=Math.min(height-1,Math.round(centerY+width*.043));
    let minX=right,minY=bottom,maxX=left,maxY=top,ink=0;
    for (let y=top;y<=bottom;y++) for (let x=left;x<=right;x++) {
      const p=4*(y*width+x);
      if (data[p+2]<105 || data[p+2]-data[p]<55 || data[p+2]-data[p+1]<15) continue;
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);
      minY=Math.min(minY,y);maxY=Math.max(maxY,y);ink++;
    }
    if (!ink) return 'no blue pixels in the right edge';
    return 'blue bounds '+[minX,minY,maxX,maxY].join(',')+' ('+ink+' pixels)';
  }
  async function pageAfter(hit,device) {
    await clickLabel(hit,device);
    return labels();
  }
  async function openDetails(device) {
    await guard(device);
    let page=await labels();
    let scrolls=0;
    for (let step=0;step<12;step++) {
      if (details(page,device)) return content(page,device);
      const pane=content(page,device);
      const editorHeader=only(pane.filter(hit=>hit.y<usbCanvas.height*.13),'name');
      if (editorHeader) {
        const back=pane.filter(hit=>names.includes(hit.label) && hit.x<editorHeader.x &&
          Math.abs(hit.y-editorHeader.y)<usbCanvas.height*.018);
        if (back.length===1) {
          page=await pageAfter(back[0],device);
          continue;
        }
      }
      const candidates=pane.filter(hit=>names.includes(hit.label));
      const rows=pane.filter(hit=>hit.label==='connected' && candidates.some(name=>
        name.x<hit.x && Math.abs(name.y-hit.y)<Math.min(usbCanvas.width,usbCanvas.height)*.015));
      if (rows.length) {
        const frame=usbCanvas.getContext('2d').getImageData(0,0,usbCanvas.width,usbCanvas.height);
        const buttons=[...new Set(candidates.map(hit=>hit.label))]
          .map(accessory=>findConnectedAccessoryInfo(pane,frame,accessory)).filter(Boolean);
        if (rows.length===1) note(device.family+' connected row icon: '+describeRowIcon(frame,rows[0].y));
        note(device.family+' connected row information buttons detected: '+buttons.length);
        if (buttons.length===1) {
          note(device.family+' opening connected accessory information at '+Math.round(buttons[0].x)+','+Math.round(buttons[0].y));
          page=await pageAfter(buttons[0],device);
          for (let retry=0;retry<2 && !details(page,device);retry++) {
            await sleep(450);
            page=await labels();
          }
          if (details(page,device)) return content(page,device);
        }
        throw Error(device.family+' could not confirm connected accessory details ('+report(page)+')');
      }
      if (pane.some(hit=>hit.label==='bluetooth' && hit.y<usbCanvas.height*.14 &&
          hit.x>usbCanvas.width*(device.family==='iPad'?.5:.33))) {
        if (scrolls++>=6) break;
        await scrollPanel(device,-4);
        page=await labels();
        continue;
      }
      const cancel=only(page,'cancel');
      if (cancel && page.some(hit=>['settings','search','no-results'].includes(hit.label))) {
        page=await pageAfter(cancel,device);
        continue;
      }
      const from=device.family==='iPad' ? page.filter(hit=>hit.x<=usbCanvas.width*.37) : pane;
      const row=only(from.filter(hit=>hit.y>usbCanvas.height*.13),'bluetooth');
      if (row) {
        page=await pageAfter(row,device);
        continue;
      }
      const back=only(pane.filter(hit=>hit.x<usbCanvas.width*.35 && hit.y<usbCanvas.height*.15),'settings');
      if (back) {
        page=await pageAfter(back,device);
        continue;
      }
      break;
    }
    throw Error(device.family+' connected accessory row unavailable ('+report(page)+')');
  }
  async function rename(device,pane,value,existingEditor) {
    const fieldRow=only(pane,'name');
    if (!fieldRow || !title(pane)) throw Error('Accessory name row is ambiguous');
    const rowValue=pane.filter(hit=>names.includes(hit.label) && hit.x>fieldRow.x &&
      Math.abs(hit.y-fieldRow.y)<usbCanvas.height*.018);
    let field=existingEditor;
    for (let attempt=0;!existingEditor && attempt<2;attempt++) {
      const evidence=attempt ? field : pane;
      const row=only(evidence,'name');
      if (!row || !details(evidence,device) || title(evidence).label!==title(pane).label) break;
      const target=attempt ? row : rowValue.length===1 ? rowValue[0] : row;
      field=content(await pageAfter(target,device),device);
      for (let retry=0;retry<3 && details(field,device);retry++) {
        await sleep(600);
        field=content(await labels(),device);
      }
      if (!details(field,device)) break;
    }
    const header=only(field.filter(hit=>hit.y<usbCanvas.height*.20),'name');
    const old=header ? field.filter(hit=>names.includes(hit.label) && hit.y>header.y+usbCanvas.height*.025) : [];
    if (old.length!==1 || old[0].label!==title(pane).label || field.some(hit=>['forget','disconnect'].includes(hit.label)))
      throw Error('Accessory name editor could not be confirmed ('+report(field)+')');
    await clickLabel(old[0],device);
    // Command+A operates only inside the positively identified accessory editor.
    await strokes([{modifiers:8,keys:[4]},...IpadKeyboard.textStrokes(value.text)],device);
    field=content(await labels(),device);
    if (!field.some(hit=>hit.label===value.label && Math.abs(hit.y-old[0].y)<usbCanvas.height*.03))
      throw Error('New accessory name could not be read in the editor');
    let done=only(field,'done');
    if (!done) {
      const glyph=()=>findAccessoryNameDone(usbCanvas.getContext('2d').getImageData(
        0,0,usbCanvas.width,usbCanvas.height),header);
      const first=glyph(),serial=usbFrameNumber;
      if (first) {
        await waitForUsbFrame(serial,900);
        const second=usbFrameNumber!==serial && glyph();
        if (second && Math.hypot(first.x-second.x,first.y-second.y)<3) done=second;
      }
    }
    note(device.family+' saving accessory display name via '+(done?'visible Done control':'Return'));
    if (done) await clickLabel(done,device);
    else await strokes([{modifiers:0,keys:[40]}],device);
    let saved=content(await labels(),device);
    if (!details(saved,device)) {
      // Some versions retain the editor after Return. The top-left navigation
      // button is the accessory's old or new name.
      const back=saved.filter(hit=>names.includes(hit.label) && hit.y<usbCanvas.height*.12)
        .filter(hit=>hit.x<(device.family==='iPad'?.56:.31)*usbCanvas.width);
      if (back.length===1) saved=content(await pageAfter(back[0],device),device);
    }
    if (!details(saved,device) || title(saved)?.label!==value.label)
      throw Error('Saved accessory name was not verified ('+report(saved)+')');
    return saved;
  }
  async function disconnectSeRadio(device,accessory,observer) {
    await guard(device);
    let page=await labels();
    for (let attempt=0;attempt<2 && details(page,device);attempt++) {
      const back=only(page.filter(hit=>hit.x<usbCanvas.width*.30 && hit.y<usbCanvas.height*.14),'bluetooth');
      if (!back) throw Error('SE accessory details have no confirmed Bluetooth back button');
      const button=attempt ? {x:Math.max(usbCanvas.width*.034,back.x-usbCanvas.width*.065),y:back.y} : back;
      page=await pageAfter(button,device);
      for (let i=0;i<3 && details(page,device);i++) {
        await sleep(500);
        page=await labels();
      }
    }
    if (details(page,device)) throw Error('SE remained on accessory details after Bluetooth back navigation');
    let listVerified=false;
    const getToggle=async current=>{
      const frame=usbCanvas.getContext('2d').getImageData(0,0,usbCanvas.width,usbCanvas.height);
      let diagnostic;
      const toggle=findAuditedSeBluetoothSwitch(current,frame,{accessory,diagnostic:why=>{diagnostic=why;}});
      if (diagnostic) note('SE Bluetooth list audit: '+JSON.stringify(diagnostic));
      listVerified=diagnostic?.icons===1 && diagnostic.statuses===1 &&
        ['enabled-switch-unproven','non-rounded-switch','right-hand-thumb-unproven',
          'single-connected-accessory-and-enabled-switch'].includes(diagnostic.reason);
      if (!toggle && diagnostic?.reason==='enabled-switch-unproven' && readSwitchShape) {
        const row=only(current.filter(hit=>hit.x<frame.width*.4 && hit.y>frame.height*.09),'bluetooth');
        if (row) note('SE Bluetooth switch outline: '+await readSwitchShape(row));
      }
      return toggle;
    };
    let toggle=await getToggle(page);
    if (!toggle && !listVerified && page.some(hit=>hit.label==='bluetooth' && hit.y<usbCanvas.height*.14)) {
      await scrollPanel(device,6);
      page=await labels();
      toggle=await getToggle(page);
    }
    const firstVerified=listVerified;
    if (!toggle && !firstVerified) throw Error('SE radio left on: could not verify that only the tested accessory was connected ('+report(page)+')');
    const serial=usbFrameNumber;
    await waitForUsbFrame(serial,1200);
    const second=usbFrameNumber!==serial && await getToggle(await labels());
    if ((!toggle || !second) && firstVerified && listVerified && usbFrameNumber!==serial) {
      note('Tactile switch ready: only LFC connected on SE in two frames; observer is waiting for SE Bluetooth off and on');
      await waitFor(()=>observer.state.gapObserved || observer.state.error,550000,()=>'Manual SE toggle was not observed');
      return;
    }
    if (!second || Math.hypot(second.x-toggle.x,second.y-toggle.y)>3) throw Error('SE Bluetooth switch or connected items changed');
    note('Turning off Bluetooth on SE after confirming its only connected accessory in two frames');
    await clickLabel(second,device,true);
  }
  return {
    canCycle(device) { return disconnectable.has(device.id); },
    nameConfirmed(device) { return confirmedNames.has(device.id); },
    async inspect(device) {
      await guard(device);
      const start=content(await labels(),device);
      const header=only(start.filter(hit=>hit.y<usbCanvas.height*.13),'name');
      const back=header && start.find(hit=>names.includes(hit.label) && hit.x<header.x &&
        Math.abs(hit.y-header.y)<usbCanvas.height*.018);
      const editor=back && start.some(hit=>hit.label===back.label && hit.y>header.y+usbCanvas.height*.025) &&
        !details(start,device) ? start : null;
      let pane;
      try { pane=editor || await openDetails(device); }
      catch (error) {
        note(device.family+' accessory details unverified: '+error.message);
        await $('preview-mode').onclick();
        return;
      }
      const alias=aliases[device.family];
      if (!alias) throw Error('Unrecognized USB target');
      const current=title(pane).label;
      original.set(device.id,current);
      if (current===alias.label) inspected.set(device.id,current);
      else if (only(pane,'name')) {
        try {
          pane=await rename(device,pane,alias,editor);
          inspected.set(device.id,alias.label);
          note(device.family+' saved accessory display name '+alias.text);
        } catch (error) {
          note(device.family+' accessory rename attempt: '+error.message);
          pane=await openDetails(device);
          inspected.set(device.id,title(pane).label);
          note(device.family+' actual accessory title after attempt: '+title(pane).label);
        }
      } else {
        inspected.set(device.id,current);
        note(device.family+' connected accessory details have no recognized Name row ('+report(pane)+')');
      }
      if (!details(pane,device)) pane=await openDetails(device);
      if (only(pane,'disconnect')) disconnectable.add(device.id);
      await $('preview-mode').onclick();
    },
    async check(device) {
      if (!inspected.has(device.id)) {
        await this.inspect(device);
        return;
      }
      const pane=await openDetails(device);
      if (title(pane).label!==inspected.get(device.id)) {
        const before=original.get(device.id);
        const previous=before==='computer' ? {text:'LFC',label:'computer'} :
          Object.values(aliases).find(alias=>alias.label===before);
        if (previous && only(pane,'name')) await rename(device,pane,previous);
        throw Error('Accessory display name changed across devices; independent names could not be confirmed');
      }
      if (title(pane).label===aliases[device.family]?.label) confirmedNames.add(device.id);
      note(device.family+' accessory detail title rechecked: '+title(pane).label);
      await $('preview-mode').onclick();
    },
    async cycle(target,targetPeer,other,otherPeer,radioOnly=false) {
      if (radioOnly && target.family!=='iPhone') throw Error('Radio-only acceptance requires the SE');
      const pane=radioOnly ? [] : await openDetails(target);
      const expectedName=inspected.get(target.id) ?? title(pane)?.label ?? 'computer';
      const disconnect=radioOnly ? null : only(pane,'disconnect');
      if (!disconnect && target.family!=='iPhone')
        throw Error('No individual Disconnect action in the connected accessory details ('+report(pane)+')');
      const observer=await createBluetoothCycleObserver(()=>api('status'),target.id,targetPeer,{
        otherUsbId:other.id,otherPeerId:otherPeer,timeoutMs:600000,
        onPhase:phase=>note('Single-device Bluetooth cycle: '+phase+(phase==='incomplete'?' '+observer.state.error:''))
      });
      try {
        if (disconnect) {
          note('Clicking Disconnect on '+target.family+' for '+title(pane).label);
          try { await clickLabel(disconnect,target,true); }
          catch (error) { if (!observer.state.gapObserved) throw error; }
          await sleep(1400);
        }
        for (let attempt=0;disconnect && attempt<2 && !observer.state.gapObserved && !observer.state.error;attempt++) {
          let sheet=await labels();
          note('After individual Disconnect: '+report(sheet));
          const cancel=only(sheet,'cancel');
          if (cancel) {
            const actions=sheet.filter(hit=>hit.label==='disconnect' &&
              Math.hypot(hit.x-disconnect.x,hit.y-disconnect.y)>usbCanvas.height*.04);
            const confirm=actions.length===1 ? actions[0] : null;
            if (confirm) await clickLabel(confirm,target,true);
            break;
          }
          if (attempt===0 && details(sheet,target) && title(content(sheet,target)).label===title(pane).label) {
            await sleep(900);
            sheet=content(await labels(),target);
            const row=only(sheet,'disconnect');
            const status=await api('status');
            const bothOnline=[targetPeer,otherPeer].every(id=>status.peers.some(peer=>peer.id===id));
            if (row && bothOnline && status.verifiedPeerId===targetPeer && details(sheet,target) &&
                title(sheet).label===title(pane).label && !observer.state.gapObserved && !observer.state.error) {
              note('Retrying unchanged Disconnect row on '+target.family);
              await clickLabel({x:usbCanvas.width*(target.family==='iPad'?.68:.50),y:row.y},target,true);
            }
          }
          await sleep(1000);
        }
        if (!observer.state.gapObserved && !observer.state.error && target.family==='iPhone') {
          try { await waitFor(()=>observer.state.gapObserved || observer.state.error,3500,()=>'Link still online'); }
          catch { /* Try the SE-only switch if the complete paired list can be audited. */ }
          if (!observer.state.gapObserved && !observer.state.error) await disconnectSeRadio(target,expectedName,observer);
        }
        await waitFor(()=>observer.state.gapObserved || observer.state.error,15000,
          ()=>'No target-only Bluetooth gap was observed after Disconnect');
        if (observer.state.error) throw Error(observer.state.error);
        note('Reconnect the previously paired accessory on '+target.family+' if it does not return automatically');
        await waitFor(()=>observer.state.candidateIds.length || observer.state.error,590000,()=>'Target did not return');
        if (observer.state.error) throw Error(observer.state.error);
        const verifyDeadline=Date.now()+60000;
        while (!observer.state.verified && !observer.state.error && Date.now()<verifyDeadline) {
          await updateBluetooth();
          const candidates=availablePeers.filter(peer=>peer.absolute && observer.state.candidateIds.includes(peer.id));
          for (const peer of candidates) {
            await verifyBluetoothDevice(()=>usbDeviceId===target.id && !observer.state.error,true,peer.id);
            if (observer.state.verified) break;
          }
          await sleep(400);
        }
        if (!observer.state.verified) throw Error(observer.state.error || 'New Bluetooth subscription could not be matched to the USB picture');
        const result=await observer.done;
        if (!result.verified) throw Error(result.error || 'New subscription could not be verified');
        const name=title(await openDetails(target)).label;
        if (name!==expectedName) throw Error('Accessory display name changed after reconnect');
        note(target.family+' reconnected with a new verified subscription, other receivers stayed online, accessory title '+name);
        await $('preview-mode').onclick();
      } finally { observer.stop(); }
    }
  };
}
