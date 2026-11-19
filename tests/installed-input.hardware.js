// Opt-in only. This test will type exclusively into a recognized empty system
// search field, and erase exclusively a verified marker previously written here.
function installedInput({note,waitFor,sleep,recoverMarker}) {
  const markers = {iPad:['583762','pad-marker'],iPhone:['926438','phone-marker']};
  const touched = new Map();
  const fields = new Map();
  let webRequest = false;
  async function labels(region) {
    if (webRequest) throw Error('Concurrent screen read');
    webRequest=true;
    try {
      const found = await new Promise((resolve,reject)=>{
        const web=window.chrome.webview;
        const done = event => {clearTimeout(timer); web.removeEventListener('message',done); resolve(event.data);};
        const timer=setTimeout(()=>{web.removeEventListener('message',done);reject(Error('Local OCR timed out'));},14000);
        web.addEventListener('message',done);
        let source=usbCanvas;
        if (region) {
          source=document.createElement('canvas');
          source.width=Math.round(region.w*2); source.height=Math.round(region.h*2);
          const ctx=source.getContext('2d');
          ctx.filter='grayscale(1) contrast(155%)';
          ctx.drawImage(usbCanvas,region.x,region.y,region.w,region.h,0,0,source.width,source.height);
        }
        web.postMessage(source.toDataURL('image/jpeg',0.94).split(',')[1]);
      });
      if (!Array.isArray(found)) throw Error('Local OCR could not read a frame');
      return region ? found.map(h=>({...h,x:h.x/2+region.x,y:h.y/2+region.y})) : found;
    } finally { webRequest=false; }
  }
  async function guard(device) {
    let freshProbeStarted=false;
    await waitFor(async()=>{
      await updateBluetooth();
      const status=await api('status');
      const bound = usbDeviceId===device.id && status.activeDeviceId===device.id && status.verifiedPeerId &&
        !status.needsPairing && !status.assistantEnabled && keyboardConnected &&
        status.peers.some(p=>p.id===status.verifiedPeerId && p.boundDeviceId===device.id);
      if (bound && absoluteActive && !absoluteVerified && !freshProbeStarted && !aiming && !pairing) {
        freshProbeStarted=true;
        await $('verify-position').onclick();
      }
      return bound && absoluteVerified && !aiming;
    },18000,()=> 'Input requires the verified USB, pointer and keyboard of '+device.family);
    await enterPictureMode();
    if (!hasPictureKeyboardFocus()) throw Error('Picture keyboard failed to focus');
  }
  async function drain() {
    await waitFor(()=>!aiming && !pictureQueue.length && !lease,6000,()=> 'Input queue did not settle');
    await sleep(700);
    if ($('notice').classList.contains('error') && $('notice').textContent) {
      const detail=$('notice').textContent.split('「')[0].slice(0,90);
      throw Error('Installed input was rejected: '+detail);
    }
  }
  async function clickLabel(hit,device,disconnecting=false) {
    await guard(device);
    const g=pictureGeometry();
    const target={x:Math.round(hit.x*(g.w-1)/(g.width-1)),y:Math.round(hit.y*(g.h-1)/(g.height-1))};
    // A tiny iOS accessory information button can be a distinct hover target.
    // Reproduce a user moving onto its visible center before pressing it.
    await ensureLease();
    const point=absoluteCoordinates(target,g.w,g.h);
    const serial=usbFrameNumber;
    await api('input',{lease,seq:++seq,kind:'absolute',buttons:0,x:point.x,y:point.y,settle:true});
    await waitForUsbFrame(serial,650);
    await sleep(230);
    const gesture=new PictureMouseGesture(target,1,100);
    gesture.end(target);
    pictureQueue.push({target,geometry:g,gesture});
    await processPictureQueue();
    if (disconnecting) return;
    await drain();
    // iOS expands the hover cursor over text fields. Move it away before
    // reading the placeholder or marker; otherwise it obscures the evidence.
    await ensureLease();
    try { await api('input',{lease,seq:++seq,kind:'absolute',buttons:0,x:29100,y:25400,settle:true}); }
    finally { await stopControl(true); }
    await sleep(420);
  }
  async function strokes(keys,device) {
    await guard(device);
    queueStrokes(keys);
    await drain();
    if ($('input-result').textContent!=='键盘输入') throw Error('Installed UI did not acknowledge a keyboard report');
  }
  async function scrollPanel(device,delta) {
    await guard(device);
    const g=pictureGeometry();
    if (device.family==='iPad' && delta<0) {
      const count=(scrollPanel.attempt || 0)+1;
      scrollPanel.attempt=count;
      if (count%3===0) {
        const x=Math.round(g.width*.977), y=Math.round(g.height*.69);
        const crop=usbCanvas.getContext('2d').getImageData(x-4,y-6,8,12).data;
        const uniform=crop.every((value,index)=>index%4===3 || Math.abs(value-crop[index%4])<13);
        if (uniform) {
          const start={x:Math.round(g.w*.977),y:Math.round(g.h*.69)};
          const end={x:start.x,y:Math.round(g.h*.28)};
          const gesture=new PictureMouseGesture(start,1);
          pictureQueue.push({target:start,geometry:g,gesture}); processPictureQueue();
          await sleep(220);
          for (let i=1;i<=9;i++) {
            gesture.move({x:start.x,y:Math.round(start.y+(end.y-start.y)*i/9)}); await sleep(50);
          }
          gesture.end(end); await drain();
          return;
        }
      }
      if (count%4===0) delta=-delta;
    }
    const target={x:Math.round(g.w*(device.family==='iPad'?.73:.56)),y:Math.round(g.h*.57)};
    pictureQueue.push({target,geometry:g,wheel:delta});
    await processPictureQueue();
    await drain();
  }
  function only(found,label) {
    const matches=found.filter(x=>x.label===label);
    return matches.length===1 ? matches[0] : null;
  }
  function report(found) {
    return [...new Set(found.map(hit=>hit.label+'@'+Math.round(100*hit.x/usbCanvas.width)+','+
      Math.round(100*hit.y/usbCanvas.height)))].join(' ') || 'no recognized system labels';
  }
  function emptyField(found) {
    const hits=found.filter(h=>h.label==='search' && h.x<usbCanvas.width*.78);
    const unique=hits.filter((h,index)=>!hits.slice(0,index).some(p=>Math.abs(h.x-p.x)<usbCanvas.width*.04 &&
      Math.abs(h.y-p.y)<usbCanvas.height*.025));
    const cancel=found.find(h=>h.label==='cancel');
    if (cancel) {
      const aligned=unique.filter(h=>h.x<cancel.x && Math.abs(h.y-cancel.y)<usbCanvas.height*.045);
      if (aligned.length===1) return aligned[0];
    }
    return unique.length===1 ? unique[0] : null;
  }
  async function searchLabels(device) {
    const whole=await labels();
    if (emptyField(whole)) return whole;
    const w=usbCanvas.width, h=usbCanvas.height;
    const sidebar=device.family==='iPad' ? Math.round(w*.39) : w;
    const cancel=whole.find(hit=>hit.label==='cancel' && hit.y<h*.22);
    if (cancel) {
      // Exclude the clear/cancel buttons and software keyboard when a caret
      // or magnifier is being grouped with the two placeholder characters.
      const crop={x:Math.round(w*.025),y:Math.max(0,Math.round(cancel.y-h*.027)),
        w:Math.round(cancel.x-w*.12),h:Math.round(h*.054)};
      if (crop.w>0) {
        const matched=(await labels(crop)).filter(hit=>hit.label==='search' || hit.label.endsWith('-marker'));
        if (matched.length) return [...whole,...matched];
      }
    }
    for (const y of [0,.70]) {
      const region=await labels({x:0,y:Math.round(h*y),w:sidebar,h:Math.round(h*.30)});
      const hits=region.filter(hit=>hit.label==='search' || hit.label.endsWith('-marker'));
      if (hits.length) return [...whole,...hits];
    }
    return whole;
  }
  async function readEmpty(device) {
    let found;
    for (let i=0;i<3;i++) {
      found=await searchLabels(device);
      if (emptyField(found)) return found;
      await sleep(200);
    }
    return found;
  }
  function ownMarker(found,device) {
    const field=fields.get(device.id);
    return field && found.find(h=>h.label===markers[device.family][1] &&
      Math.abs(h.y-field.y)<usbCanvas.height*.075 && Math.abs(h.x-field.x)<usbCanvas.width*.27);
  }
  async function readMarker(device) {
    const field=fields.get(device.id), width=usbCanvas.width, height=usbCanvas.height;
    const x=Math.max(0,Math.round(field.x-width*.13));
    const y=Math.max(0,Math.round(field.y-height*.04));
    const region={x,y,w:Math.min(width-x,Math.round(width*.33)),h:Math.min(height-y,Math.round(height*.08))};
    let found=[];
    for (let i=0;i<3;i++) {
      found=await labels();
      if (ownMarker(found,device)) return found;
      found.push(...await labels(region));
      if (ownMarker(found,device)) return found;
      await sleep(220);
    }
    return found;
  }
  async function accessoryLabels() {
    const result=await labels();
    const w=usbCanvas.width,h=usbCanvas.height;
    const add=hits=>{
      for (const hit of hits) if (!result.some(p=>p.label===hit.label &&
          Math.abs(p.x-hit.x)<w*.025 && Math.abs(p.y-hit.y)<h*.012)) result.push(hit);
    };
    if (w>h && !result.some(hit=>hit.label==='bluetooth' && hit.x<w*.38 && hit.y>h*.14) &&
        result.some(hit=>['settings','general','about'].includes(hit.label))) {
      // The sidebar says Bluetooth beside a separate current status. Reading
      // just the label column avoids joining the two strings into a single line.
      const sidebar=await labels({x:Math.round(w*.035),y:Math.round(h*.20),
        w:Math.round(w*.14),h:Math.round(h*.68)});
      add(sidebar.filter(hit=>hit.label==='bluetooth'));
    }
    if (w>h && result.some(hit=>hit.label==='bluetooth' && hit.x>w*.38 && hit.y<h*.12)) {
      // A connected status in the last visible iPad row can be missed when
      // the entire screen is read alongside its sidebar and information icon.
      for (const [left,span,allowed] of [[.395,.25,['computer','pad-name','phone-name']],
          [.72,.19,['connected','not-connected']]]) {
        const column=await labels({x:Math.round(w*left),y:Math.round(h*.11),w:Math.round(w*span),h:Math.round(h*.88)});
        add(column.filter(hit=>allowed.includes(hit.label)));
      }
    }
    if (result.some(hit=>hit.label==='name' && hit.y<h*.12) &&
        !result.some(hit=>['computer','pad-name','phone-name'].includes(hit.label) && hit.y>h*.09)) {
      const left=w>h ? .40 : .035;
      const field=await labels({x:Math.round(w*left),y:Math.round(h*.09),
        w:Math.round(w*(w>h?.43:.70)),h:Math.round(h*.16)});
      add(field.filter(hit=>['computer','pad-name','phone-name'].includes(hit.label)));
    }
    return result;
  }
  function readSwitchShape(row) {
    const w=usbCanvas.width,h=usbCanvas.height;
    if (!row || w>=h || row.label!=='bluetooth' || row.x>w*.36 || row.y<h*.10 || row.y>h*.22) return '';
    const left=Math.floor(w*.735),top=Math.round(row.y-w*.056);
    const width=Math.floor(w*.253),height=Math.round(w*.112);
    const pixels=usbCanvas.getContext('2d').getImageData(left,top,width,height).data;
    const rows=[];
    for (let y=0;y<height;y+=5) {
      let s='';
      for (let x=0;x<width;x+=5) {
        const p=(y*width+x)*4, r=pixels[p],g=pixels[p+1],b=pixels[p+2];
        s+=g>r+28 && g>b+14 ? 'G' : Math.max(r,g,b)-Math.min(r,g,b)>30 ? '+' :
          r<90 ? '#' : r<175 ? 'o' : r<225 ? '.' : ' ';
      }
      rows.push(s);
    }
    return 'switch-only mask '+left+','+top+' step 5 '+rows.join('|');
  }
  async function openSearch(device) {
    await guard(device);
    let found=await readEmpty(device);
    const scene = rows=>rows.map(h=>h.label+'@'+Math.round(100*h.x/usbCanvas.width)+','+Math.round(100*h.y/usbCanvas.height)).join(' ');
    note(device.family+' recognized controls: '+scene(found));
    if (found.some(h=>h.label.endsWith('-marker'))) throw Error('Existing test marker detected on '+device.family);
    if (device.family==='iPhone' && !emptyField(found) && only(found,'cancel') &&
        found.some(h=>h.label==='search' && h.y>usbCanvas.height*.75)) {
      await clickLabel(only(found,'cancel'),device);
      found=await readEmpty(device);
      note(device.family+' after closing the previously prepared system search: '+scene(found));
    }
    const existingField=emptyField(found), cancel=only(found,'cancel');
    const focusedSystemSearch=existingField && cancel && Math.abs(cancel.y-existingField.y)<usbCanvas.height*.04 &&
      (fields.has(device.id) || found.some(h=>h.label==='search' && h.x>usbCanvas.width*.78 && h.y>usbCanvas.height*.75));
    let empty = focusedSystemSearch || found.some(h=>['settings','general','about'].includes(h.label)) ? existingField : null;
    if (!empty && device.family==='iPad' && found.some(h=>h.label==='settings' && h.x<usbCanvas.width*.48) &&
        found.some(h=>h.label==='general' || h.label==='about')) {
      const g=pictureGeometry();
      const heading=found.find(h=>h.label==='settings' && h.x<usbCanvas.width*.48);
      const target={x:Math.round(Math.max(.15,heading.x/g.width)*(g.w-1)),y:Math.round(g.h*.38)};
      for (let i=0;i<2 && !empty;i++) {
        pictureQueue.push({target,geometry:g,wheel:11});
        await processPictureQueue();
        await drain();
        found=await searchLabels(device); empty=emptyField(found);
      }
      if (!empty) {
        // Pull the visible Settings sidebar down past its top edge, as on iPad.
        const start={x:target.x,y:Math.round(g.h*.22)}, end={x:target.x,y:Math.round(g.h*.55)};
        const gesture=new PictureMouseGesture(start,1);
        pictureQueue.push({target:start,geometry:g,gesture}); processPictureQueue();
        await sleep(260);
        for (let step=1;step<=6;step++) {
          gesture.move({x:start.x,y:Math.round(start.y+(end.y-start.y)*step/6)}); await sleep(50);
        }
        gesture.end(end); await drain();
        found=await searchLabels(device); empty=emptyField(found);
        note(device.family+' after pulling the Settings sidebar: '+scene(found));
      }
    }
    if (!empty && device.family==='iPhone' && found.some(h=>['general','about','bluetooth'].includes(h.label))) {
      const back = only(found.filter(h=>h.x<usbCanvas.width/3 && h.y<usbCanvas.height/6),'settings');
      if (back && back.x<usbCanvas.width/3 && back.y<usbCanvas.height/5) {
        await clickLabel(back,device);
        found=await searchLabels(device); empty=emptyField(found);
        note(device.family+' after Settings back button: '+scene(found));
      }
      if (!empty && found.some(h=>h.label==='settings' && h.y<usbCanvas.height*.22 && h.x>usbCanvas.width*.34)) {
          const g=pictureGeometry(), start={x:Math.round(g.w*.54),y:Math.round(g.h*.26)};
          for (let i=0;i<3 && !empty;i++) {
            pictureQueue.push({target:{x:Math.round(g.w*.65),y:Math.round(g.h*.46)},geometry:g,wheel:18});
            await processPictureQueue(); await drain();
            found=await searchLabels(device); empty=emptyField(found);
          }
          if (!empty) {
          const gesture=new PictureMouseGesture(start,1);
          pictureQueue.push({target:start,geometry:g,gesture}); processPictureQueue();
          await sleep(300);
          for (let i=1;i<=8;i++) { gesture.move({x:start.x,y:start.y+Math.round(g.h*.34*i/8)}); await sleep(45); }
          gesture.end({x:start.x,y:start.y+Math.round(g.h*.34)});
          await drain(); found=await searchLabels(device); empty=emptyField(found);
          note(device.family+' after revealing Settings search: '+scene(found));
          }
      }
    }
    if (!empty) {
      // A system search shortcut neither enters text nor submits anything.
      await strokes([{modifiers:8,keys:[44]}],device);
      found=await searchLabels(device); empty=emptyField(found);
      note(device.family+' after system search shortcut: '+scene(found));
    }
    if (!empty) throw Error(device.family+' has no unique visible empty search field ('+report(found)+')');
    note(device.family+' confirmed empty search field; no other-device marker');
    await clickLabel(empty,device);
    // Re-read the field after the click and before sending any text.
    found=await readEmpty(device);
    empty=emptyField(found);
    if (!empty || found.some(h=>h.label.endsWith('-marker'))) throw Error('Search focus could not be confirmed ('+report(found)+')');
    fields.set(device.id,empty);
  }
  return {
    tools:{guard,labels:accessoryLabels,clickLabel,strokes,report,only,scrollPanel,readSwitchShape},
    pending() { return [...touched.values()]; },
    async resume(device) {
      await guard(device);
      const found=await readEmpty(device), field=emptyField(found), cancel=only(found,'cancel');
      if (!field || !cancel || Math.abs(field.y-cancel.y)>usbCanvas.height*.05 ||
          found.some(hit=>hit.label.endsWith('-marker'))) throw Error('Previously focused empty search was not verified ('+report(found)+')');
      fields.set(device.id,field);
      note(device.family+' previously prepared search is focused, empty, and contains no other-device marker');
    },
    async prepare(device) {
      if (!markers[device.family]) throw Error('Expected a recognized iPad or iPhone model');
      if (recoverMarker===device.family) {
        await guard(device);
        const page=await searchLabels(device);
        const cancel=only(page,'cancel');
        if (!cancel && emptyField(page) && page.some(h=>['settings','general','bluetooth'].includes(h.label))) {
          note(device.family+' earlier marker already cleared; original Settings search is empty');
        } else if (!cancel || !(page.some(h=>['settings','general','about','bluetooth'].includes(h.label)) ||
            page.some(h=>h.label===markers[device.family][1] || h.label==='search'))) {
          throw Error('Could not confirm the existing system search field for recovery');
        } else {
          fields.set(device.id,{x:usbCanvas.width*(device.family==='iPad'?.055:.15),y:cancel.y});
          if (ownMarker(await readMarker(device),device)) {
            touched.set(device.id,device);
            await this.clear(device);
          } else if (!emptyField(await readEmpty(device))) {
            throw Error('Previously entered marker could not be verified for recovery ('+report(page)+')');
          }
        }
      }
      await openSearch(device);
      await $('preview-mode').onclick();
    },
    async enter(device) {
      await guard(device);
      const before=await readEmpty(device);
      if (!emptyField(before) || before.some(h=>h.label.endsWith('-marker'))) throw Error(device.family+' search field was not still empty');
      note(device.family+' previously focused field is still empty immediately before typing');
      const [digits]=markers[device.family];
      touched.set(device.id,device);
      await strokes(IpadKeyboard.textStrokes(digits),device);
      const found=await readMarker(device);
      if (!ownMarker(found,device)) throw Error(device.family+' typed marker not observed in its search field ('+report(found)+')');
      note(device.family+' search field received '+digits);
      await $('preview-mode').onclick();
    },
    async clear(device,crossDevice=false) {
      await guard(device);
      const [digits,label]=markers[device.family];
      const found=await readMarker(device);
      const marker=ownMarker(found,device);
      if (!marker || found.some(h=>h.label.endsWith('-marker') && h.label!==label)) {
        throw Error(device.family+' original marker not exclusive; skipped deletion ('+report(found)+')');
      }
      if (crossDevice) note(device.family+' retained its own marker when the other device was selected');
      const cancel=only(found.filter(h=>Math.abs(h.y-marker.y)<usbCanvas.height*.07),'cancel');
      if (cancel) {
        // Click the empty part of this exact field to place the caret after
        // the marker, staying well to the left of both the clear and cancel controls.
        const after={x:marker.x+.37*(cancel.x-marker.x),y:marker.y};
        await clickLabel(after,device);
      }
      await strokes(Array.from(digits,()=>({modifiers:0,keys:[42]})),device);
      let cleared=await readEmpty(device);
      if (!emptyField(cleared) && cancel && ownMarker(cleared,device)) {
        await clickLabel(cancel,device);
        cleared=await readEmpty(device);
      }
      if (!emptyField(cleared) || ownMarker(cleared,device)) throw Error(device.family+' marker cleanup not confirmed ('+report(cleared)+')');
      note(device.family+' marker cleared and empty field verified');
      touched.delete(device.id);
      await $('preview-mode').onclick();
    }
  };
}
