const $ = id => document.getElementById(id);
const instruments = {
  gaida:{name:'Gaida',baseHz:334,notes:[{name:'E4',hz:329.63},{name:'F♯4',hz:369.99},{name:'G♯4',hz:415.3},{name:'A4',hz:440},{name:'B4',hz:493.88},{name:'C♯5',hz:554.37},{name:'D5',hz:587.33},{name:'E5',hz:659.25}]},
  viola:{name:'Viola',baseHz:196,notes:[{name:'G3',hz:196},{name:'A3',hz:220},{name:'B♭3',hz:233.08},{name:'C4',hz:261.63},{name:'D4',hz:293.66},{name:'E♭4',hz:311.13},{name:'F4',hz:349.23},{name:'G4',hz:392}]}
};
let selectedInstrument = 'gaida', notes = instruments.gaida.notes;
const room = {holes:'1111111',noteHeld:false,energy:0,tilt:0,chanterAt:0,bagAt:0};
let code = '', role = '', audio = null, tilt = 0, busy = false;
let mode = 'manual', waitingSince = 0, permissionAttempt = 0, audioAttempt = 0;
let audioLoading = false, audioError = '', session = 0;
const motion = new AirflowMotion();
const tone = new TiltTone();
let airflow = 35, gainTarget = 0;
let orientationPermission = 'unknown', orientationWaitingSince = 0;
const hasNotes = () => role==='chanter'||role==='solo';
const hasSound = () => role==='bag'||role==='solo';
function setInstrument(name) {
  selectedInstrument=instruments[name]?name:'gaida';notes=instruments[selectedInstrument].notes;
  $('gaidaCredit').hidden=selectedInstrument!=='gaida';$('violaCredit').hidden=selectedInstrument!=='viola';
  drawHoles();
}
$('sensitivity').value=Math.round(motion.sensitivity*100);
$('sensitivityValue').textContent=Math.round(motion.sensitivity*100)+'%';
$('fade').value=Math.round(motion.releaseSeconds*10);
$('fadeValue').textContent=motion.releaseSeconds.toFixed(1)+' s';
$('tiltSensitivity').value=Math.round(tone.sensitivity*100);
$('tiltSensitivityValue').textContent=Math.round(tone.sensitivity*100)+'%';
$('sensitivity').oninput=()=>{
  motion.sensitivity=Number($('sensitivity').value)/100;
  $('sensitivityValue').textContent=$('sensitivity').value+'%';
};
$('fade').oninput=()=>{
  motion.releaseSeconds=Number($('fade').value)/10;
  $('fadeValue').textContent=motion.releaseSeconds.toFixed(1)+' s';
};
$('tiltSensitivity').oninput=()=>{
  tone.sensitivity=Number($('tiltSensitivity').value)/100;
  $('tiltSensitivityValue').textContent=$('tiltSensitivity').value+'%';
};
const clamp = (x,a,b) => Math.min(b,Math.max(a,x));
function error(message='') { $('error').textContent = message; }
async function api(body) {
  const response = await fetch('/api/room',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Connection failed');
  return data;
}
// The last pressed note wins; releasing it returns to an earlier held note.
const heldNotes = new Map();
let noteQueue = Promise.resolve(), lastRoomRead = performance.now();
function drawHoles() {
  const selected = [...room.holes].filter(h=>h==='0').length;
  [...$('holes').children].forEach((button,i)=>{
    button.textContent=notes[i].name;button.setAttribute('aria-label','Hold '+notes[i].name);
    const active=room.noteHeld&&selected===i;
    button.classList.toggle('open',active);button.setAttribute('aria-pressed',active);
  });
  $('noteName').textContent=room.noteHeld?'Playing '+notes[selected].name:'Hold a note to play';
}
function sendNoteState() {
  const body={action:'update',code,role:'chanter',holes:room.holes,noteHeld:room.noteHeld};
  // Serialize presses, releases and heartbeats so an older press cannot overtake release.
  noteQueue=noteQueue.catch(()=>{}).then(()=>api(body));
  return noteQueue;
}
function updateHeldNotes() {
  const selected=[...heldNotes.values()].pop();
  room.noteHeld=selected!==undefined;
  if(room.noteHeld)room.holes='0'.repeat(selected)+'1'.repeat(7-selected);
  drawHoles();
  if(role==='chanter')sendNoteState().catch(e=>error(e.message));
}
function releaseNotes() { heldNotes.clear();updateHeldNotes(); }
for (let i=0;i<notes.length;i++) {
  const button=document.createElement('button');button.className='hole';
  button.textContent=notes[i].name;button.setAttribute('aria-label','Hold '+notes[i].name);
  button.addEventListener('pointerdown',ev=>{
    if(!hasNotes()||(ev.pointerType==='mouse'&&ev.button!==0))return;
    ev.preventDefault();
    // A note press is already a valid mobile user gesture, so solo play can
    // unlock Web Audio here instead of making the user find a second control.
    if(role==='solo'&&!audio&&!audioLoading)startAudio();
    button.setPointerCapture(ev.pointerId);
    heldNotes.set('pointer:'+ev.pointerId,i);updateHeldNotes();
  });
  const release=ev=>{if(heldNotes.delete('pointer:'+ev.pointerId))updateHeldNotes();};
  button.addEventListener('pointerup',release);
  button.addEventListener('pointercancel',release);
  button.addEventListener('lostpointercapture',release);
  button.addEventListener('keydown',ev=>{
    if(hasNotes()&&[' ','Enter'].includes(ev.key)) {
      ev.preventDefault();if(ev.repeat)return;
      if(role==='solo'&&!audio&&!audioLoading)startAudio();
      heldNotes.set('key:'+i+':'+ev.key,i);updateHeldNotes();
    }
  });
  button.addEventListener('keyup',ev=>{
    if([' ','Enter'].includes(ev.key)){ev.preventDefault();if(heldNotes.delete('key:'+i+':'+ev.key))updateHeldNotes();}
  });
  button.addEventListener('blur',()=>{
    let changed=false;
    for(const key of heldNotes.keys())if(key.startsWith('key:'+i+':')){heldNotes.delete(key);changed=true;}
    if(changed)updateHeldNotes();
  });
  button.addEventListener('contextmenu',ev=>ev.preventDefault());
  $('holes').append(button);
}
window.addEventListener('blur',()=>{if(hasNotes())releaseNotes();});
window.addEventListener('pagehide',()=>{if(hasNotes())releaseNotes();});
drawHoles();
function showInstrument(nextRole) {
  role=nextRole;session++;
  $('start').hidden=true;$('play').hidden=false;
  $('sessionCard').hidden=nextRole==='solo';
  $('chanter').hidden=!hasNotes();$('bag').hidden=!hasSound();
  $('soloSoundStart').hidden=nextRole!=='solo';
  $('securityNotice').hidden=!hasSound()||window.isSecureContext;
  $('chanterLabel').textContent=nextRole==='solo'?'ONE PHONE · NOTES':'PHONE 1 · CHANTER';
  $('bagLabel').textContent=nextRole==='solo'?'ONE PHONE · MOVEMENT & SOUND':'PHONE 2 · BAG';
  $('chanterHelp').textContent=nextRole==='solo'?'Keep a note held while you move this phone. Movement controls volume and tilt changes tone brightness.':'Share the room code with phone 2. Hold a note here; move phone 2 to control volume. Moving this button phone does not control volume.';
  $('bagHelp').textContent=nextRole==='solo'?'First tap Start audio + movement and allow sensor access. Then hold a note above while moving this phone to shape the sound.':'Tap Start audio + movement and allow sensor access. Hold a note on phone 1. Move this phone to change volume; tilt it to change tone brightness.';
  $('playStatus').textContent=nextRole==='solo'?'Tap Start audio + movement, then hold a note above and move this phone.':'Tap Start audio + movement on this phone. Keep a note held on phone 1.';
  $('diagRoomLabel').textContent=nextRole==='solo'?'Local finger note':'Server airflow / finger note';
}
function enterSolo(instrument=selectedInstrument) {
  error();code='';
  setInstrument(instrument);
  room.holes='1111111';room.noteHeld=false;room.energy=0;room.tilt=0;
  showInstrument('solo');drawHoles();
  history.replaceState(null,'',location.pathname+'?mode=solo&instrument='+selectedInstrument);
}
async function join(next,mode) {
  try { error(); const data=await api({action:'join',code:next,role:mode});setInstrument(data.instrument);code=next;showInstrument(mode);
    $('code').textContent=code;
    history.replaceState(null,'','?room='+code);
  } catch(e) { error(e.message); }
}
$('chooseSolo').onclick=()=>{$('modeChoices').hidden=true;$('soloSetup').hidden=false;};
$('backFromSolo').onclick=()=>{$('soloSetup').hidden=true;$('modeChoices').hidden=false;error();};
$('soloGaida').onclick=()=>enterSolo('gaida');
$('soloViola').onclick=()=>enterSolo('viola');
$('chooseMultiple').onclick=()=>{$('modeChoices').hidden=true;$('multipleSetup').hidden=false;};
$('backToModes').onclick=()=>{$('multipleSetup').hidden=true;$('modeChoices').hidden=false;error();};
async function createRoom(instrument) {try{const data=await api({action:'create',instrument});await join(data.code,'chanter');}catch(e){error(e.message);}}
$('createGaida').onclick=()=>createRoom('gaida');
$('createViola').onclick=()=>createRoom('viola');
$('join').onclick=()=>join($('entry').value.trim().toUpperCase(),'bag');
$('entry').value=(new URLSearchParams(location.search).get('room')||'').toUpperCase();
$('entry').oninput=()=>{ $('entry').value=$('entry').value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6); };
$('leave').onclick=()=>{if(hasNotes())releaseNotes();session++;useManual();tone.reset();orientationPermission='unknown';tilt=0;stopAudio();role='';code='';$('play').hidden=true;$('start').hidden=false;$('modeChoices').hidden=false;$('soloSetup').hidden=true;$('multipleSetup').hidden=true;history.replaceState(null,'',location.pathname);};

async function startAudio() {
  if (audioLoading) return;
  const attempt = ++audioAttempt;
  audioError = '';
  if (audio) {
    try { await audio.ctx.resume(); } catch(e) { audioError=e.message; }
    return;
  }
  let ctx;
  audioLoading = true;
  $('audio').textContent='Loading audio...';
  try {
    ctx=new (window.AudioContext || window.webkitAudioContext)();
    // Unlock in the tap handler, before fetching/decoding on mobile browsers.
    await ctx.resume();
    const soundNames=selectedInstrument==='viola'?['viola']:['chanter','drone'];
    const buffers=await Promise.all(soundNames.map(async name=>{
      const response=await fetch('/audio/'+name+'.wav'+(name==='viola'?'?v=2':''));if(!response.ok)throw new Error('Sound could not load');
      return ctx.decodeAudioData(await response.arrayBuffer());
    }));
    if (attempt !== audioAttempt || !hasSound()) { await ctx.close(); return; }
    const melody=ctx.createBufferSource(), bass=ctx.createBufferSource();
    const melodyGain=ctx.createGain(), droneGain=ctx.createGain(), filter=ctx.createBiquadFilter();
    melody.buffer=buffers[0];melody.loop=true;
    melodyGain.gain.value=0;droneGain.gain.value=0;filter.type='lowpass';filter.Q.value=.707;
    melody.connect(filter).connect(melodyGain).connect(ctx.destination);
    if(selectedInstrument==='gaida'){
      bass.buffer=buffers[1];bass.loop=true;bass.playbackRate.value=164.81/167;
      bass.connect(droneGain).connect(ctx.destination);bass.start();
    }
    melody.start();audio={ctx,melody,bass:selectedInstrument==='gaida'?bass:null,melodyGain,droneGain,filter};
  }catch(e){if(ctx)await ctx.close();audioError=e.message;$('playStatus').textContent='Audio could not start: '+e.message;error('Audio could not start: '+e.message);}
  finally { audioLoading=false; }
}
function stopAudio(){audioAttempt++;if(audio){audio.ctx.close();audio=null;}$('audio').textContent='Start audio';}
$('audio').onclick=startAudio;
function sensorStatus(message, failed=false) {
  $('sensorStatus').textContent=message;
  $('sensorStatus').classList.toggle('failure',failed);
}
function useManual() {
  permissionAttempt++;mode='manual';motion.reset();
  $('manual').disabled=false;$('sensors').disabled=false;
  $('sensors').textContent='Enable movement';
  sensorStatus('Manual mode: movement does not control volume.');
  $('tiltStatus').textContent=tone.count>0?'Fixed manual airflow is on. Tilt still controls tone brightness.':'Tilt needs sensor access; tap Start audio + movement first.';
}
function sensorFailure(message) {
  mode='error';motion.target=0;tone.reset();tilt=0;
  $('manual').disabled=false;$('sensors').disabled=false;
  $('sensors').textContent='Retry movement';
  sensorStatus(message+' Move the manual slider to use manual airflow.',true);
  $('tiltStatus').textContent='Tilt tone control is paused until movement is enabled again.';
}
$('manualMode').onclick=useManual;
$('manual').oninput=()=>{
  useManual();$('manualValue').textContent=$('manual').value+'%';
};
$('sensors').onclick=async()=>{
  const attempt=++permissionAttempt;
  mode='permission';motion.reset();tone.reset();orientationPermission='unknown';
  $('manual').disabled=true;$('sensors').disabled=true;
  sensorStatus('Requesting motion access...');
  $('tiltStatus').textContent='Waiting for tilt permission and data.';
  try{
    if(!window.isSecureContext)throw new Error(role==='solo'?'Movement requires HTTPS. Open this app from a trusted HTTPS address.':'Movement requires HTTPS. Open the same trusted HTTPS server address on both phones.');
    if(typeof DeviceMotionEvent==='undefined')throw new Error('This browser does not provide motion events.');
    // Both requests must start inside the same Safari tap activation.
    const motionRequest=typeof DeviceMotionEvent.requestPermission==='function' ? DeviceMotionEvent.requestPermission() : Promise.resolve('granted');
    const hasOrientation=typeof DeviceOrientationEvent!=='undefined';
    const orientationRequest=hasOrientation && typeof DeviceOrientationEvent.requestPermission==='function' ? DeviceOrientationEvent.requestPermission() : Promise.resolve(hasOrientation?'granted':'unavailable');
    const [motionResult,orientationResult]=await Promise.allSettled([motionRequest,orientationRequest]);
    if(attempt!==permissionAttempt)return;
    if(motionResult.status!=='fulfilled'||motionResult.value!=='granted')throw new Error('Motion permission denied. Allow motion in browser settings, then retry.');
    orientationPermission=orientationResult.status==='fulfilled' ? orientationResult.value : 'denied';
    orientationWaitingSince=performance.now();
    if(orientationPermission!=='granted')$('tiltStatus').textContent='Tilt unavailable: orientation permission was not granted. Airflow still works.';
    mode='waiting';waitingSince=performance.now();
    sensorStatus('Waiting for real acceleration data (up to 3 seconds)...');
  }catch(e){if(attempt===permissionAttempt)sensorFailure(e.message);}
};
$('startMovement').onclick=()=>{
  // Invoke both permission and audio unlock in the original Safari tap gesture.
  const permission=$('sensors').onclick();
  const playback=startAudio();
  return Promise.all([permission,playback]);
};
$('soloStartMovement').onclick=()=>$('startMovement').onclick();
window.addEventListener('devicemotion',ev=>{
  if(!hasSound()||!['waiting','motion'].includes(mode))return;
  if(!motion.sample(ev,performance.now()))return;
  if(mode!=='motion') {
    mode='motion';$('sensors').textContent='Movement enabled';
    sensorStatus('Receiving movement: hold still to fade, move gently to add air.');
  }
});
const screenAngle=()=>{
  if(typeof screen!=='undefined'&&Number.isFinite(screen.orientation?.angle))return screen.orientation.angle;
  return Number.isFinite(Number(window.orientation))?Number(window.orientation):0;
};
window.addEventListener('deviceorientation',ev=>{
  if(!hasSound()||(!['waiting','motion'].includes(mode)&&!(mode==='manual'&&orientationPermission==='granted')))return;
  const wasCalibrating=!!tone.calibration;
  if(!tone.sample(ev,screenAngle(),performance.now()))return;
  tilt=clamp(tone.screenForward,-90,90);
  if(tone.screenChanged)$('tiltStatus').textContent='Screen orientation changed. Hold the phone still and tap Calibrate tilt again.';
  else if(wasCalibrating&&!tone.calibration)$('tiltStatus').textContent='Calibrated. Tilt the phone to brighten the tone; return here for the neutral tone.';
  else if(tone.count===1)$('tiltStatus').textContent='Tilt data received. Hold the phone still in your playing position and tap Calibrate.';
});
$('calibrate').onclick=()=>{
  const tiltEnabled=['waiting','motion'].includes(mode)||(mode==='manual'&&orientationPermission==='granted');
  if(!hasSound()||!tiltEnabled||tone.last===null||performance.now()-tone.last>1000){
    $('tiltStatus').textContent='Enable movement and wait for live tilt data, then try Calibrate.';
    return;
  }
  tone.beginCalibration(performance.now());
  $('tiltStatus').textContent='Hold the phone still in its normal playing position for one second...';
};
document.addEventListener('visibilitychange',()=>{
  if(document.hidden&&hasNotes())releaseNotes();
  if(document.hidden&&hasSound()&&['waiting','motion','permission'].includes(mode)) {
    permissionAttempt++;
    sensorFailure('Movement paused because this page was hidden. Return to this page and retry movement.');
    airflow=0;
    if(audio) {
      audio.melodyGain.gain.setTargetAtTime(0,audio.ctx.currentTime,.06);
      audio.droneGain.gain.setTargetAtTime(0,audio.ctx.currentTime,.09);
    }
  }
});
let lastFrame=performance.now(), lastDisplay=0;
function updateLocal(now) {
  const dt=Math.min(.1,Math.max(0,(now-lastFrame)/1000));lastFrame=now;
  if(hasSound()) {
    if(mode==='waiting'&&now-waitingSince>3000) sensorFailure('No usable acceleration events arrived. Check motion permission and use a browser with sensor support.');
    if(mode==='motion'&&now-motion.last>1500) sensorFailure('Motion data stopped arriving. Keep this page visible and retry movement.');
    if(tone.calibration&&now-tone.calibration.since>2500){
      tone.calibration=null;$('tiltStatus').textContent='Calibration timed out: no steady tilt data arrived. Try again while holding the phone still.';
    }
    if(mode==='motion'&&orientationPermission==='granted'&&tone.count===0&&now-orientationWaitingSince>3000&&$('tiltStatus').textContent.startsWith('Waiting')){
      $('tiltStatus').textContent='No tilt events arrived. Airflow still works; check Safari motion and orientation access.';
    }
    airflow=mode==='manual'?Number($('manual').value):mode==='motion'?motion.step(now,dt):0;
    const rawFilter=mode==='manual'&&tone.count===0?2600:tone.step(now,dt);
    const filterFrequency=selectedInstrument==='viola'?Math.max(2800,rawFilter):rawFilter;
    const noteActive=room.noteHeld && (role==='solo'||now-lastRoomRead<1500);
    const pressure=noteActive?clamp(airflow/100,0,1):0;
    gainTarget=pressure*.65;
    if(audio) {
      const t=audio.ctx.currentTime;
      const open=[...room.holes].filter(h=>h==='0').length;
      audio.melody.playbackRate.setTargetAtTime(notes[open].hz/instruments[selectedInstrument].baseHz,t,.025);
      audio.melodyGain.gain.setTargetAtTime(gainTarget,t,.06);
      audio.droneGain.gain.setTargetAtTime(selectedInstrument==='gaida'?pressure*.3:0,t,.09);
      audio.filter.frequency.setTargetAtTime(filterFrequency,t,.05);
    }
    if(now-lastDisplay>100) {
      lastDisplay=now;
      let reason;
      if(!window.isSecureContext)reason=role==='solo'?'Motion blocked: this address is not trusted HTTPS. Reopen this app over HTTPS.':'Motion blocked: this address is not trusted HTTPS. Use the same HTTPS address on both phones.';
      else if(mode==='manual')reason=tone.count>0?'Manual airflow is fixed. Tilt still changes tone brightness.':'Manual mode: movement has no effect. Tap Start audio + movement on this phone.';
      else if(mode==='permission'||mode==='waiting')reason='Waiting for motion permission and usable sensor data.';
      else if(mode==='error')reason=$('sensorStatus').textContent;
      else if(!audio)reason='Motion is arriving, but audio is not started. Tap Start audio.';
      else if(audio.ctx.state!=='running')reason='Audio is paused. Tap Resume audio.';
      else if(role!=='solo'&&now-lastRoomRead>=1500)reason='Room updates stopped. Check the connection on both phones.';
      else if(!room.noteHeld)reason=role==='solo'?'Hold a note button above while moving this phone.':'Hold a note button on phone 1 while moving this phone.';
      else if(motion.target===0)reason='Hold the note and move this phone for volume; tilt changes tone brightness separately.';
      else reason='Movement controls volume. Tilt controls tone brightness.';
      if($('playStatus').textContent!==reason)$('playStatus').textContent=reason;
      $('air').textContent=Math.round(airflow)+'%';
      $('diagMode').textContent=mode;
      $('diagEvents').textContent=motion.count+' valid / '+motion.received+' received / '+(motion.last===null?'no data':Math.round(now-motion.last)+' ms ago');
      $('diagAccel').textContent=motion.raw?['x','y','z'].map(k=>k+': '+(motion.raw[k]===null?'missing':motion.raw[k].toFixed(2))).join(' / ')+' m/s^2':'No usable acceleration';
      $('diagSignal').textContent=motion.source+' / '+motion.magnitude.toFixed(2)+' m/s^2';
      $('diagRawTilt').textContent=tone.raw?'beta '+tone.raw.beta.toFixed(1)+'° / gamma '+tone.raw.gamma.toFixed(1)+'° / screen '+tone.raw.screenAngle+'°':'No usable beta/gamma';
      $('diagTilt').textContent=tone.neutral?Math.round(tone.brightness*100)+'% brightness / neutral beta '+tone.neutral.beta.toFixed(1)+'°, gamma '+tone.neutral.gamma.toFixed(1)+'°':'Waiting for neutral position';
      $('diagFilter').textContent=audio?audio.filter.frequency.value.toFixed(0)+' Hz (target '+filterFrequency.toFixed(0)+' Hz)':filterFrequency.toFixed(0)+' Hz target; audio not started';
      $('diagAir').textContent=airflow.toFixed(1)+'% (motion target '+(motion.target*100).toFixed(1)+'%)';
      $('diagGain').textContent=audio?audio.melodyGain.gain.value.toFixed(3)+' -> '+gainTarget.toFixed(3)+' / drone '+audio.droneGain.gain.value.toFixed(3):'Audio not started (target '+gainTarget.toFixed(3)+')';
      $('diagAudio').textContent=audioError|| (audio?audio.ctx.state:audioLoading?'loading':'not started');
      $('audio').textContent=audio?(audio.ctx.state==='running'?'Audio is on':'Resume audio'):audioLoading?'Loading audio...':'Start audio';
      $('diagRoom').textContent=(role==='solo'?'Local':'Server')+' / '+(noteActive?'held '+notes[[...room.holes].filter(h=>h==='0').length].name:'no held note');
    }
  }
  requestAnimationFrame(updateLocal);
}
requestAnimationFrame(updateLocal);

setInterval(async()=>{
  if(!role||role==='solo'||busy)return;busy=true;const currentSession=session;
  try{
    if(role==='bag') await api({action:'update',code,role,energy:airflow,tilt});
    else await sendNoteState();
    const response=await fetch('/api/room?code='+encodeURIComponent(code),{cache:'no-store'});
    if(!response.ok)throw new Error('Connection interrupted');const state=await response.json();
    if(currentSession!==session)return;
    lastRoomRead=performance.now();
    if(role==='chanter'){delete state.holes;delete state.noteHeld;}
    Object.assign(room,state);
    $('connection').textContent=Date.now()-(role==='bag'?room.chanterAt:room.bagAt)<4000?'Both phones connected':'Waiting for other phone';
    if(role==='chanter')drawHoles();
    error();
  }catch(e){if(currentSession===session)error(e.message+'. Retrying...');}finally{busy=false;}
},220);

const initialParams=new URLSearchParams(location.search);
if(initialParams.get('mode')==='solo')enterSolo(initialParams.get('instrument'));
