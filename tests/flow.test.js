const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {spawn} = require('node:child_process');
const AirflowMotion = require('../public/motion');
const TiltTone = AirflowMotion.TiltTone;
const root = path.join(__dirname, '..');
const linear = x => ({acceleration:{x,y:0,z:0}});

test('recorded chanter remains audible at neutral and brightens across the filter range',()=>{
  const wav=fs.readFileSync(path.join(root,'public/audio/chanter.wav'));
  let offset=12,rate=22050,data;
  while(offset+8<=wav.length){
    const size=wav.readUInt32LE(offset+4),id=wav.toString('ascii',offset,offset+4);
    if(id==='fmt ')rate=wav.readUInt32LE(offset+12);
    if(id==='data')data=wav.subarray(offset+8,offset+8+size);
    offset+=8+size+(size%2);
  }
  function filteredRms(cutoff){
    const cos=Math.cos(2*Math.PI*cutoff/rate),alpha=Math.sin(2*Math.PI*cutoff/rate)/(2*.707);
    const a0=1+alpha,b0=(1-cos)/(2*a0),b1=(1-cos)/a0,a1=-2*cos/a0,a2=(1-alpha)/a0;
    let x1=0,x2=0,y1=0,y2=0,sum=0,count=0;
    for(let i=0;i<data.length/2;i++){
      const x=data.readInt16LE(i*2)/32768;
      const y=b0*x+b1*x1+b0*x2-a1*y1-a2*y2;
      x2=x1;x1=x;y2=y1;y1=y;
      if(i>rate*.2){sum+=y*y;count++;}
    }
    return Math.sqrt(sum/count);
  }
  const neutral=filteredRms(1200),bright=filteredRms(8000);
  assert.ok(neutral>.1,'neutral filter should retain the recorded note');
  assert.ok(bright>neutral*1.2,'tilt filter range should materially change this sample');
});

test('null axes fall back to gravity; stationary gravity is silent and lateral movement registers', () => {
  const m = new AirflowMotion();
  const event = {acceleration:{x:null,y:null,z:null},accelerationIncludingGravity:{x:0,y:0,z:9.81}};
  assert.equal(m.sample(event,0),true);
  for(let t=16;t<1000;t+=16) {m.sample(event,t);m.step(t,.016);}
  assert.equal(m.airflow,0);
  event.accelerationIncludingGravity.x=3;
  m.sample(event,1000);
  assert.ok(m.step(1000,.016)>5);
  assert.equal(m.source,'gravity filtered');
  assert.equal(m.sample({acceleration:{x:null,y:NaN,z:0}},1016),false);
});

test('motion envelope has smooth attack/release, comparable event rates, and no stale sustain', () => {
  function run(hz) {
    const m=new AirflowMotion();
    for(let i=0;i<hz;i++){m.sample(linear(1.62),i*1000/hz);m.step(i*1000/hz,1/hz);}
    assert.ok(m.airflow>.44 && m.airflow<.48);
    const before=m.airflow;
    m.sample(linear(0),1000);m.step(1000,1/hz);
    assert.ok(m.airflow>0 && m.airflow<before);
    for(let t=1100;t<6000;t+=16)m.step(t,.016);
    assert.ok(m.airflow<.02);
    return before;
  }
  assert.ok(Math.abs(run(30)-run(60))<.001);
});

test('gentle movement rises gradually and sound lingers after movement stops',()=>{
  const m=new AirflowMotion();
  m.sample(linear(.2),0);
  const first=m.step(0,.016);
  assert.ok(m.target>.05,'gentle movement should pass the lower threshold');
  assert.ok(first>0 && first<2,'a single sample should not make volume jump');
  for(let t=16;t<1016;t+=16){m.sample(linear(1),t);m.step(t,.016);}
  const moving=m.airflow;
  for(let t=1016;t<2016;t+=16){m.sample(linear(0),t);m.step(t,.016);}
  assert.ok(m.airflow>moving*.2,'fade should retain airflow after one second');
  assert.ok(m.airflow<moving*.3,'fade should still decrease');
});

test('movement sensitivity and fade controls change motion behavior without changing manual values',()=>{
  const low=new AirflowMotion(),high=new AirflowMotion();
  low.sensitivity=.5;high.sensitivity=2;
  low.sample(linear(.5),0);high.sample(linear(.5),0);
  assert.ok(high.target>low.target*3);
  const quick=new AirflowMotion(),long=new AirflowMotion();
  quick.releaseSeconds=.4;long.releaseSeconds=3;
  for(let t=0;t<1000;t+=16){quick.sample(linear(2),t);long.sample(linear(2),t);quick.step(t,.016);long.step(t,.016);}
  for(let t=1000;t<2000;t+=16){quick.sample(linear(0),t);long.sample(linear(0),t);quick.step(t,.016);long.step(t,.016);}
  assert.ok(long.airflow>quick.airflow*3);
});

test('ordinary movement has headroom; full airflow needs much stronger acceleration',()=>{
  function airflowAt(acceleration){
    const m=new AirflowMotion();
    for(let i=0;i<60;i++){
      m.sample(linear(acceleration),i*1000/60);
      m.step(i*1000/60,1/60);
    }
    return m.airflow;
  }
  const gentle=airflowAt(.4),moderate=airflowAt(1.62),strong=airflowAt(3),full=airflowAt(5.2);
  assert.ok(gentle>.1 && gentle<.2);
  assert.ok(moderate>.4 && moderate<.5);
  assert.ok(strong>.65 && strong<.75);
  assert.ok(full>.98);
});

// Execute the shipped app in two isolated phone-like JS contexts. These fakes
// verify event wiring/AudioParam targets, not Safari hardware or audible output.
function phone(fetcher, {secure=true, permission='granted', tiltPermission='granted'}={}) {
  const elements={};let now=0, frame, poll;
  const element=()=>({children:[],value:'35',textContent:'',classList:{toggle(){}},
    setAttribute(){},setPointerCapture(){},listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},append(child){this.children.push(child);}});
  for(const [,id] of fs.readFileSync(path.join(root,'public/index.html'),'utf8').matchAll(/id="([^"]+)"/g))elements[id]=element();
  const events={};const trace=[];
  const param=()=>({value:0,setTargetAtTime(value,time,tau){this.value=value;this.tau=tau;}});
  class AudioContext {
    constructor(){this.state='suspended';this.currentTime=0;this.destination={};}
    async resume(){trace.push('resume');this.state='running';}
    async close(){this.state='closed';}
    async decodeAudioData(){return {};}
    createBufferSource(){return {playbackRate:param(),connect(node){return node;},start(){}};}
    createGain(){return {gain:param(),connect(node){return node;}};}
    createBiquadFilter(){return {frequency:param(),Q:param(),connect(node){return node;}};}
  }
  const context=vm.createContext({AirflowMotion,TiltTone,console,URLSearchParams,Date,
    performance:{now:()=>now},document:{getElementById:id=>{assert.ok(elements[id],id);return elements[id];},createElement:element,addEventListener:(name,fn)=>events[name]=fn},
    location:{search:'',pathname:'/'},history:{replaceState(){}},
    window:{isSecureContext:secure,AudioContext,addEventListener:(name,fn)=>events[name]=fn},screen:{orientation:{angle:0}},
    DeviceMotionEvent:{requestPermission:async()=>{trace.push('motion permission');return permission;}},
    DeviceOrientationEvent:{requestPermission:async()=>{trace.push('orientation permission');return tiltPermission;}},
    requestAnimationFrame:fn=>frame=fn,setInterval:fn=>poll=fn,
    fetch:async(url,opts)=>{if(url.startsWith('/audio/')){trace.push('fetch audio');return {ok:true,arrayBuffer:async()=>new ArrayBuffer(0)};}return fetcher(url,opts);}
  });
  vm.runInContext(fs.readFileSync(path.join(root,'public/app.js'),'utf8'),context);
  return {elements,events,trace,eval:s=>vm.runInContext(s,context),poll:()=>poll(),
    tick(ms=16){now+=ms;frame(now);},async bag(){await this.eval("join('ABCDEF','bag')");await this.poll();}};
}
const roomResponse = async()=>({ok:true,json:async()=>({holes:'1111111',noteHeld:true,energy:0,tilt:0,chanterAt:Date.now(),bagAt:Date.now()})});

test('manual slider independently drives gain at 0/50/100 and motion cannot override it',async()=>{
  const p=phone(roomResponse);await p.bag();await p.elements.audio.onclick();
  assert.deepEqual(p.trace.slice(0,2),['resume','fetch audio']);
  for(const value of [0,50,100]) {
    p.elements.manual.value=String(value);p.elements.manual.oninput();
    p.events.devicemotion(linear(9));p.tick(120);
    assert.equal(p.eval('audio.melodyGain.gain.value'),value/100*.65);
    assert.equal(p.eval('audio.droneGain.gain.value'),value/100*.3);
    assert.equal(p.eval('audio.melody.playbackRate.value'),329.63/334);
  }
  assert.ok(p.eval('audio.melodyGain.gain.tau')>0);
});

test('phone feel controls tune motion live and survive switching to manual and back',async()=>{
  const p=phone(roomResponse);await p.bag();await p.elements.startMovement.onclick();
  p.elements.sensitivity.value='180';p.elements.sensitivity.oninput();
  p.elements.fade.value='24';p.elements.fade.oninput();
  assert.equal(p.eval('motion.sensitivity'),1.8);
  assert.equal(p.eval('motion.releaseSeconds'),2.4);
  p.elements.tiltSensitivity.value='160';p.elements.tiltSensitivity.oninput();
  assert.equal(p.eval('tone.sensitivity'),1.6);
  p.elements.manualMode.onclick();
  assert.equal(p.eval('motion.sensitivity'),1.8);
  assert.equal(p.eval('motion.releaseSeconds'),2.4);
  assert.equal(p.eval('tone.sensitivity'),1.6);
  p.elements.manual.value='40';p.elements.manual.oninput();p.tick();
  assert.equal(p.eval('airflow'),40);
  assert.equal(p.elements.sensitivityValue.textContent,'180%');
  assert.equal(p.elements.fadeValue.textContent,'2.4 s');
  assert.equal(p.elements.tiltSensitivityValue.textContent,'160%');
});

test('no events/null-only events, denied permission, and HTTP never claim movement enabled',async()=>{
  for(const options of [{secure:false},{permission:'denied'},{}]) {
    const p=phone(roomResponse,options);await p.bag();await p.elements.sensors.onclick();
    p.events.devicemotion({acceleration:{x:null,y:null,z:null}});p.tick(3101);
    assert.equal(p.eval('mode'),'error');
    assert.notEqual(p.elements.sensors.textContent,'Movement enabled');
    const message=p.elements.sensorStatus.textContent;
    await p.poll();assert.equal(p.elements.sensorStatus.textContent,message);
    assert.equal(p.eval('airflow'),0);
    assert.equal(p.elements.manual.disabled,false);
  }
});

test('motion drives local audio despite room outage; fingers alone choose pitch; stale sensors mute',async()=>{
  let offline=false;
  const p=phone((...args)=>{if(offline)throw Error('offline');return roomResponse(...args);});
  await p.bag();await p.elements.audio.onclick();await p.elements.sensors.onclick();
  assert.equal(p.eval('mode'),'waiting');
  offline=true;await p.poll();
  for(let i=0;i<60;i++){p.events.devicemotion(linear(1.62));p.tick();}
  assert.equal(p.elements.sensors.textContent,'Movement enabled');
  assert.ok(p.eval('audio.melodyGain.gain.value')>.27);
  assert.equal(p.eval('audio.melody.playbackRate.value'),329.63/334);
  p.eval("room.holes='0000000'");p.tick();
  assert.equal(p.eval('audio.melody.playbackRate.value'),659.25/334);
  p.tick(1600);assert.equal(p.eval('mode'),'error');
  assert.equal(p.eval('audio.melodyGain.gain.value'),0);
  assert.match(p.elements.sensorStatus.textContent,/stopped/);
  p.elements.manualMode.onclick();p.tick();assert.equal(p.eval('mode'),'manual');
});

test('real server preserves two-phone room, airflow and finger updates, assets and leave cleanup',async t=>{
  const port=42000+Math.floor(Math.random()*10000);
  const server=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(()=>server.kill());
  await new Promise((resolve,reject)=>{server.once('error',reject);server.once('exit',code=>reject(Error('server exit '+code)));server.stdout.once('data',resolve);});
  const request=(url,opts)=>fetch('http://127.0.0.1:'+port+url,opts);
  const post=body=>request('/api/room',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const violaRoom=await (await post({action:'create',instrument:'viola'})).json();
  assert.equal(violaRoom.instrument,'viola');
  const violaJoin=await (await post({action:'join',code:violaRoom.code,role:'bag'})).json();
  assert.equal(violaJoin.instrument,'viola');
  const {code}=await (await post({action:'create'})).json();
  const fingers=phone(request),bag=phone(request);
  await fingers.eval(`join('${code}','chanter')`);await bag.eval(`join('${code}','bag')`);
  await bag.elements.audio.onclick();
  bag.elements.manual.value='100';bag.elements.manual.oninput();bag.tick();await bag.poll();await fingers.poll();
  assert.equal(bag.elements.connection.textContent,'Both phones connected');
  assert.equal(fingers.elements.connection.textContent,'Both phones connected');
  await fingers.eval(`api({action:'update',code,role:'chanter',holes:'0001111',noteHeld:true})`);
  await bag.poll();bag.tick();
  assert.equal(bag.eval('audio.melody.playbackRate.value'),440/334);
  assert.equal(bag.eval('room.energy'),100);
  assert.equal(bag.eval('audio.melodyGain.gain.value'),.65);
  await fingers.eval(`api({action:'update',code,role:'chanter',holes:'0001111',noteHeld:false})`);
  await bag.poll();bag.tick();
  assert.equal(bag.eval('audio.melodyGain.gain.value'),0);
  assert.equal(bag.eval('audio.droneGain.gain.value'),0);
  for(const asset of ['/','/app.js','/motion.js','/audio/chanter.wav','/audio/drone.wav','/audio/viola.wav'])assert.equal((await request(asset)).status,200);
  assert.equal((await request('/motion.js')).headers.get('cache-control'),'no-store');
  bag.elements.leave.onclick();bag.events.devicemotion(linear(9));
  assert.equal(bag.eval('audio'),null);assert.equal(bag.eval('mode'),'manual');
});

test('backgrounding the moving phone mutes without waiting for an animation frame',async()=>{
  const p=phone(roomResponse);await p.bag();await p.elements.audio.onclick();await p.elements.sensors.onclick();
  p.events.devicemotion(linear(3));p.tick();
  assert.ok(p.eval('audio.melodyGain.gain.value')>0);
  p.eval('document.hidden=true');p.events.visibilitychange();
  assert.equal(p.eval('audio.melodyGain.gain.value'),0);
  assert.equal(p.eval('mode'),'error');
});

test('big note buttons hold, switch with multiple fingers, release and cancel without latching',async()=>{
  const sent=[];
  const p=phone(async(url,opts)=>{if(opts)sent.push(JSON.parse(opts.body));return roomResponse();});
  await p.eval("join('ABCDEF','chanter')");
  const buttons=p.elements.holes.children;
  assert.equal(buttons.length,8);
  assert.equal(buttons[0].textContent,'E4');
  const pointer=id=>({pointerId:id,pointerType:'touch',preventDefault(){}});
  buttons[0].listeners.pointerdown(pointer(1));
  assert.equal(p.eval('room.noteHeld'),true);
  buttons[7].listeners.pointerdown(pointer(2));
  assert.equal(p.eval('room.holes'),'0000000');
  buttons[7].listeners.pointerup(pointer(2));
  assert.equal(p.eval('room.holes'),'1111111');
  assert.equal(p.eval('room.noteHeld'),true);
  buttons[0].listeners.pointercancel(pointer(1));
  assert.equal(p.eval('room.noteHeld'),false);
  buttons[2].listeners.pointerdown(pointer(3));
  buttons[2].listeners.lostpointercapture(pointer(3));
  assert.equal(p.eval('room.noteHeld'),false);
  buttons[3].listeners.keydown({key:' ',preventDefault(){}});
  assert.equal(p.eval('room.holes'),'0001111');
  buttons[3].listeners.keyup({key:' ',preventDefault(){}});
  assert.equal(p.eval('room.noteHeld'),false);
  buttons[4].listeners.pointerdown(pointer(4));p.events.blur();
  assert.equal(p.eval('room.noteHeld'),false);
  await p.eval('noteQueue');
  assert.equal(sent.at(-1).noteHeld,false);
  assert.equal(buttons[0].listeners.click,undefined);
});

test('held note cannot sustain after room reads stop',async()=>{
  const p=phone(roomResponse);await p.bag();await p.elements.audio.onclick();p.tick();
  assert.ok(p.eval('audio.melodyGain.gain.value')>0);
  p.tick(1600);
  assert.equal(p.eval('audio.melodyGain.gain.value'),0);
  assert.equal(p.eval('audio.droneGain.gain.value'),0);
});

test('primary start requests motion and unlocks audio in the same tap, then motion changes gain',async()=>{
  let grant;
  const permission=new Promise(resolve=>grant=resolve);
  const p=phone(roomResponse,{permission});await p.bag();
  const started=p.elements.startMovement.onclick();
  assert.deepEqual(p.trace.slice(0,3),['motion permission','orientation permission','resume']);
  assert.equal(p.eval('mode'),'permission');
  grant('granted');await started;
  assert.equal(p.eval('mode'),'waiting');
  p.events.devicemotion(linear(0));p.tick(120);
  assert.equal(p.eval('audio.melodyGain.gain.value'),0);
  assert.match(p.elements.playStatus.textContent,/tilt changes tone brightness/);
  for(let i=0;i<25;i++){p.events.devicemotion(linear(.6));p.tick();}
  const gentle=p.eval('audio.melodyGain.gain.value');
  for(let i=0;i<25;i++){p.events.devicemotion(linear(2.4));p.tick();}
  assert.ok(gentle>0);
  assert.ok(p.eval('audio.melodyGain.gain.value')>gentle*2.5);
  assert.equal(p.eval('audio.melody.playbackRate.value'),329.63/334);
  assert.match(p.elements.playStatus.textContent,/Movement controls volume/);
});

test('alone mode combines local note buttons, movement and audio without a room',async()=>{
  const p=phone(async()=>{throw Error('solo mode must not call the room API');});
  p.elements.chooseSolo.onclick();
  p.elements.soloGaida.onclick();
  assert.equal(p.eval('role'),'solo');
  assert.equal(p.elements.chanter.hidden,false);
  assert.equal(p.elements.bag.hidden,false);
  assert.equal(p.elements.sessionCard.hidden,true);
  await p.elements.startMovement.onclick();
  const note=p.elements.holes.children[3];
  const pointer={pointerId:1,pointerType:'touch',preventDefault(){}};
  note.listeners.pointerdown(pointer);
  for(let i=0;i<35;i++){p.events.devicemotion(linear(1.62));p.tick();}
  assert.equal(p.eval('room.noteHeld'),true);
  assert.equal(p.eval('audio.melody.playbackRate.value'),440/334);
  assert.ok(p.eval('audio.melodyGain.gain.value')>.25);
  assert.match(p.elements.playStatus.textContent,/Movement controls volume/);
  note.listeners.pointerup(pointer);p.tick(120);
  assert.equal(p.eval('audio.melodyGain.gain.value'),0);
  assert.equal(p.eval('audio.droneGain.gain.value'),0);
});

test('viola mode loads its own bowed voice, note range and no gaida drone',async()=>{
  const p=phone(async()=>{throw Error('solo mode must not call the room API');});
  p.elements.chooseSolo.onclick();p.elements.soloViola.onclick();
  assert.equal(p.eval('selectedInstrument'),'viola');
  assert.equal(p.elements.holes.children[0].textContent,'C3');
  assert.equal(p.elements.holes.children[7].textContent,'C4');
  await p.elements.startMovement.onclick();
  const note=p.elements.holes.children[7];
  const pointer={pointerId:2,pointerType:'touch',preventDefault(){}};
  note.listeners.pointerdown(pointer);
  for(let i=0;i<35;i++){p.events.devicemotion(linear(1.62));p.tick();}
  assert.equal(p.eval('audio.bass'),null);
  assert.equal(p.eval('audio.droneGain.gain.value'),0);
  assert.equal(p.eval('audio.melody.playbackRate.value'),261.63/261.5);
  assert.ok(p.eval('audio.melodyGain.gain.value')>.25);
});

test('rotation alone changes tone but cannot inflate movement airflow',()=>{
  const m=new AirflowMotion(),tone=new TiltTone();
  tone.sample({beta:10,gamma:5},0,0);
  for(let i=0;i<45;i++){
    m.sample({acceleration:{x:0,y:0,z:0},accelerationIncludingGravity:{x:0,y:0,z:9.81},rotationRate:{alpha:0,beta:30,gamma:0}},i*16);
    tone.sample({beta:35,gamma:5},0,i*16);
    m.step(i*16,.016);tone.step(i*16,.016);
  }
  assert.equal(m.source,'linear');
  assert.equal(m.airflow,0);
  assert.ok(tone.frequency>5500);
});

test('missing linear axes use gravity-removal fallback; stillness is stable',()=>{
  const m=new AirflowMotion();
  const event={acceleration:{x:null,y:null,z:null},accelerationIncludingGravity:{x:0,y:0,z:9.81}};
  for(let t=0;t<1000;t+=16){m.sample(event,t);m.step(t,.016);}
  assert.equal(m.airflow,0);
  event.accelerationIncludingGravity.x=3;
  m.sample(event,1000);m.step(1000,.016);
  assert.equal(m.source,'gravity filtered');
  assert.ok(m.airflow>.05);
  const partial={acceleration:{x:.8,y:.3,z:null},accelerationIncludingGravity:null};
  assert.equal(m.sample(partial,1016),true);
  assert.equal(m.source,'partial linear');
});

test('tilt calibration handles angle wrap, screen rotation and neutral return',()=>{
  const t=new TiltTone();
  t.sample({beta:179,gamma:0},0,0);
  t.sample({beta:-179,gamma:0},0,16);
  t.step(16,.016);
  assert.ok(t.degrees<3,'beta wrap must be two degrees, not 358');
  assert.ok(t.frequency<1900);
  t.beginCalibration(100);
  for(let i=0;i<45;i++)t.sample({beta:i%2?179:-179,gamma:10},0,100+i*16);
  assert.equal(t.calibration,null);
  assert.ok(Math.abs(t.neutral.beta)>170,'circular average stays near wrap boundary');
  const portrait=new TiltTone(),landscape=new TiltTone();
  portrait.sample({beta:0,gamma:0},0,0);
  landscape.sample({beta:0,gamma:0},90,0);
  for(let i=1;i<=35;i++){
    portrait.sample({beta:24,gamma:0},0,i*16);
    landscape.sample({beta:0,gamma:-24},90,i*16);
    portrait.step(i*16,.016);landscape.step(i*16,.016);
  }
  assert.ok(Math.abs(portrait.frequency-landscape.frequency)<1);
  assert.ok(portrait.frequency>5000);
  for(let i=36;i<100;i++){
    portrait.sample({beta:0,gamma:0},0,i*16);
    portrait.step(i*16,.016);
  }
  assert.ok(Math.abs(portrait.frequency-1200)<15);
  portrait.sample({beta:25,gamma:0},0,1600);
  assert.ok(portrait.target>.5);
  portrait.sample({beta:25,gamma:0},90,1616);
  assert.equal(portrait.target,0);
  assert.equal(portrait.neutral.beta,25);
  assert.equal(portrait.screenChanged,true);
});

test('phone tilt changes filter locally while held pitch and movement gain stay constant',async()=>{
  const p=phone(roomResponse);await p.bag();await p.elements.startMovement.onclick();
  for(let i=0;i<25;i++){
    p.events.devicemotion(linear(.8));p.events.deviceorientation({beta:0,gamma:0});p.tick();
  }
  const neutral=p.eval('audio.filter.frequency.value');
  const gain=p.eval('audio.melodyGain.gain.value');
  for(let i=0;i<25;i++){
    p.events.devicemotion(linear(.8));p.events.deviceorientation({beta:32,gamma:0});p.tick();
  }
  const bright=p.eval('audio.filter.frequency.value');
  assert.ok(bright>neutral+4000);
  assert.ok(Math.abs(p.eval('audio.melodyGain.gain.value')-gain)<.005);
  assert.equal(p.eval('audio.melody.playbackRate.value'),329.63/334);
  assert.match(p.elements.diagRawTilt.textContent,/beta 32.0/);
  assert.match(p.elements.diagFilter.textContent,/Hz/);
  p.elements.calibrate.onclick();
  for(let i=0;i<50;i++){
    if(i===20||i===40)await p.poll();
    p.events.devicemotion(linear(.8));p.events.deviceorientation({beta:32,gamma:0});p.tick();
  }
  assert.match(p.elements.tiltStatus.textContent,/Calibrated/);
  assert.ok(p.eval('audio.filter.frequency.value')<1400);
  assert.ok(Math.abs(p.eval('audio.melodyGain.gain.value')-gain)<.005);
});

test('manual airflow holds volume steady while live tilt changes tone and returns to neutral',async()=>{
  const p=phone(roomResponse);await p.bag();await p.elements.startMovement.onclick();
  p.events.devicemotion(linear(0));p.events.deviceorientation({beta:0,gamma:0});p.tick();
  p.elements.manual.value='50';p.elements.manual.oninput();p.tick();
  const gain=p.eval('audio.melodyGain.gain.value');
  const neutral=p.eval('audio.filter.frequency.value');
  for(let i=0;i<30;i++){p.events.deviceorientation({beta:30,gamma:0});p.tick();}
  assert.equal(p.eval('audio.melodyGain.gain.value'),gain);
  assert.ok(p.eval('audio.filter.frequency.value')>neutral+4000);
  for(let i=0;i<60;i++){p.events.deviceorientation({beta:0,gamma:0});p.tick();}
  assert.ok(Math.abs(p.eval('audio.filter.frequency.value')-1200)<20);
  assert.equal(p.eval('audio.melodyGain.gain.value'),gain);
  assert.equal(p.eval('audio.melody.playbackRate.value'),329.63/334);
});

test('tilt sensitivity changes brightness without affecting airflow',()=>{
  const low=new TiltTone(),high=new TiltTone();
  low.sensitivity=.5;high.sensitivity=2;
  low.sample({beta:0,gamma:0},0,0);high.sample({beta:0,gamma:0},0,0);
  low.sample({beta:12,gamma:0},0,16);high.sample({beta:12,gamma:0},0,16);
  assert.ok(high.target>low.target*3);
});

test('denied tilt permission leaves movement volume usable and reports the tilt problem',async()=>{
  const p=phone(roomResponse,{tiltPermission:'denied'});await p.bag();await p.elements.startMovement.onclick();
  for(let i=0;i<15;i++){p.events.devicemotion(linear(1));p.tick();}
  assert.equal(p.eval('mode'),'motion');
  assert.ok(p.eval('audio.melodyGain.gain.value')>0);
  assert.equal(p.eval('audio.filter.frequency.value'),1200);
  assert.match(p.elements.tiltStatus.textContent,/not granted/);
});

test('calibration waits for live tilt data and reports an orientation stream that stops',async()=>{
  const p=phone(roomResponse);await p.bag();await p.elements.startMovement.onclick();
  p.elements.calibrate.onclick();
  assert.match(p.elements.tiltStatus.textContent,/wait for live tilt data/);
  p.events.devicemotion(linear(0));p.events.deviceorientation({beta:5,gamma:10});p.tick();
  p.elements.calibrate.onclick();
  for(let i=0;i<160;i++){
    if(i%20===0)await p.poll();
    p.events.devicemotion(linear(0));p.tick();
  }
  assert.equal(p.eval('tone.calibration'),null);
  assert.match(p.elements.tiltStatus.textContent,/timed out/);
});

test('visible status explains manual mode and the released-note audio gate',async()=>{
  const p=phone(roomResponse);await p.bag();await p.elements.audio.onclick();p.tick(120);
  assert.match(p.elements.playStatus.textContent,/Manual mode: movement has no effect/);
  await p.elements.startMovement.onclick();p.events.devicemotion(linear(3));
  p.eval('room.noteHeld=false');p.tick(120);
  assert.match(p.elements.playStatus.textContent,/Hold a note button/);
  assert.equal(p.eval('audio.melodyGain.gain.value'),0);
});

test('HTTP shows the secure connection blocker before motion is attempted',async()=>{
  const p=phone(roomResponse,{secure:false});await p.bag();p.tick(120);
  assert.equal(p.elements.securityNotice.hidden,false);
  assert.match(p.elements.playStatus.textContent,/Motion blocked/);
  await p.elements.startMovement.onclick();
  assert.equal(p.eval('mode'),'error');
  assert.equal(p.eval('motion.received'),0);
});
