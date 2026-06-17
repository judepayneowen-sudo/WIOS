/*
 * WHOOP Core — standalone iOS reader (Capacitor + CoreBluetooth via @capacitor-community/bluetooth-le).
 *
 * iOS/CoreBluetooth performs WHOOP's on-demand BLE encryption automatically, so the custom
 * fd4b command service (unreachable on Windows) works here. Protocol is an independent
 * clean-room implementation of the GOOSE/Gen5 frame format, verified byte-identical to the
 * known get_hello fixture (aa0108000001e67123019101363e5c8d).
 */
import { BleClient, numbersToDataView } from '@capacitor-community/bluetooth-le';
import { SplashScreen } from '@capacitor/splash-screen';

/* ----------------------------- GATT map ----------------------------------- */
const SVC    = 'fd4b0001-cce1-4033-93ce-002d5875f58a';   // custom command service
const TX     = 'fd4b0002-cce1-4033-93ce-002d5875f58a';   // command_to_strap   (write)
const RX_CMD = 'fd4b0003-cce1-4033-93ce-002d5875f58a';   // command_from_strap (notify)
const RX_EVT = 'fd4b0004-cce1-4033-93ce-002d5875f58a';   // events_from_strap  (notify)
const RX_DAT = 'fd4b0005-cce1-4033-93ce-002d5875f58a';   // data_from_strap    (notify)

const HR_SVC   = '0000180d-0000-1000-8000-00805f9b34fb';
const HR_MEAS  = '00002a37-0000-1000-8000-00805f9b34fb';
const BATT_SVC = '0000180f-0000-1000-8000-00805f9b34fb';
const BATT_LVL = '00002a19-0000-1000-8000-00805f9b34fb';
const DEV_SVC  = '0000180a-0000-1000-8000-00805f9b34fb';
const DEV_MFR  = '00002a29-0000-1000-8000-00805f9b34fb';
const DEV_MODEL= '00002a24-0000-1000-8000-00805f9b34fb';
const DEV_SERIAL='00002a25-0000-1000-8000-00805f9b34fb';
const DEV_FW   = '00002a26-0000-1000-8000-00805f9b34fb';

const PACKET_TYPE_COMMAND = 35;
const PKT = {35:'COMMAND',36:'COMMAND_RESPONSE',40:'REALTIME_DATA',43:'REALTIME_RAW_DATA',
  47:'HISTORICAL_DATA',48:'EVENT',49:'METADATA',50:'CONSOLE_LOGS',51:'REALTIME_IMU',
  52:'HISTORICAL_IMU',53:'REL_PUFFIN_EVENTS',54:'PUFFIN_EVENTS',56:'PUFFIN_METADATA'};

/* ----------------------------- CRC + framing ------------------------------ */
function crc16_modbus(bytes){
  let crc = 0xFFFF;
  for(const b of bytes){ crc ^= b; for(let i=0;i<8;i++) crc = (crc&1)?((crc>>>1)^0xA001):(crc>>>1); }
  return crc & 0xFFFF;
}
const CRC32_TABLE = (()=>{ const t=new Uint32Array(256);
  for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1); t[n]=c>>>0; } return t; })();
function crc32(bytes){ let c=0xFFFFFFFF; for(const b of bytes) c=CRC32_TABLE[(c^b)&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }
function padLen(n){ const r=n%4; return r===0?0:4-r; }

function buildCommand(sequence, command, data=[]){
  let payload=[PACKET_TYPE_COMMAND, sequence&0xFF, command&0xFF, ...data];
  for(let p=padLen(payload.length); p>0; p--) payload.push(0x00);
  const pc=crc32(payload), declared=payload.length+4;
  const head=[0xAA,0x01,declared&0xFF,(declared>>>8)&0xFF,0x00,0x01];
  const hc=crc16_modbus(head);
  return [...head, hc&0xFF,(hc>>>8)&0xFF, ...payload, pc&0xFF,(pc>>>8)&0xFF,(pc>>>16)&0xFF,(pc>>>24)&0xFF];
}
const hex = (a)=>Array.from(a, b=>b.toString(16).padStart(2,'0')).join('');
const dvBytes = (dv)=> new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);

function parseFrame(dv){
  const f = dvBytes(dv);
  if(f.length<8 || f[0]!==0xAA) return {error:'no 0xAA / short', rawHex:hex(f)};
  const declared=f[2]|(f[3]<<8);
  const headOk=crc16_modbus(f.slice(0,6))===(f[6]|(f[7]<<8));
  const truncated=f.length < 8+declared;
  let payload, payOk=null;
  if(truncated){ payload=f.slice(8); }
  else{ payload=f.slice(8,f.length-4); const got=f.slice(f.length-4); const c=crc32(payload);
    payOk = got[0]===(c&0xFF)&&got[1]===((c>>>8)&0xFF)&&got[2]===((c>>>16)&0xFF)&&got[3]===((c>>>24)&0xFF); }
  const pt=payload[0];
  return { packetType:pt, name:PKT[pt]||('?'+pt), sequence:payload[1], code:payload[2],
           headOk, payOk, truncated, payloadHex:hex(payload), rawHex:hex(f) };
}

/* ----------------------------- HRV (RMSSD) -------------------------------- */
const rr = [];           // recent RR intervals in ms
function pushRR(ms){ rr.push(ms); while(rr.length>60) rr.shift(); }
function rmssd(){
  if(rr.length<3) return null;
  let s=0,n=0; for(let i=1;i<rr.length;i++){ const d=rr[i]-rr[i-1]; s+=d*d; n++; }
  return n? Math.round(Math.sqrt(s/n)) : null;
}
function parseHeartRate(dv){
  const b=dvBytes(dv); const flags=b[0]; let i=1; let hr;
  if(flags&0x01){ hr=b[i]|(b[i+1]<<8); i+=2; } else { hr=b[i]; i+=1; }
  if(flags&0x08) i+=2;                                  // energy expended present → skip
  if(flags&0x10){ for(; i+1<b.length; i+=2){ const rrU=b[i]|(b[i+1]<<8); pushRR(Math.round(rrU*1000/1024)); } }
  return hr;
}

/* ----------------------------- UI ----------------------------------------- */
const $ = (id)=>document.getElementById(id);
function setStatus(t, on){ $('status').textContent=t; $('dot').classList.toggle('on', !!on); }
function setField(id, v){ const el=$(id); if(el) el.textContent=v; }
function log(msg, cls='dim'){ const d=document.createElement('div'); d.className='ln '+cls;
  d.textContent='['+new Date().toLocaleTimeString()+'] '+msg; $('log').appendChild(d);
  $('log').scrollTop=$('log').scrollHeight; }
function logFrame(dir, info){
  if(info.error){ log(`${dir} ${info.rawHex} ⟶ ${info.error}`,'err'); return; }
  const ok=(info.headOk && info.payOk!==false)?'✓':'⚠';
  log(`${dir} ${info.name} seq=${info.sequence} code=${info.code} `+
      `[h:${info.headOk?'ok':'BAD'} p:${info.payOk===null?'-':info.payOk?'ok':'BAD'}] ${ok}`, info.packetType===48?'evt':'rx');
  log(`     payload=${info.payloadHex}`,'dim');
}

/* ----------------------------- BLE flow ----------------------------------- */
let deviceId=null, seq=1, hrTimer=null, lastHrAt=0;

async function connect(){
  try{
    setStatus('initialising…');
    await BleClient.initialize();
    log('select your WHOOP in the chooser…');
    const device = await BleClient.requestDevice({
      namePrefix:'WHOOP',
      optionalServices:[SVC, HR_SVC, BATT_SVC, DEV_SVC],
    });
    deviceId = device.deviceId;
    log(`selected: ${device.name||'WHOOP'} [${deviceId}]`);
    setStatus('connecting…');
    await BleClient.connect(deviceId, onDisconnect);
    setStatus('connected — '+(device.name||'WHOOP'), true);
    enable(true);

    // device info + battery (standard, no auth)
    try{ const b=await BleClient.read(deviceId, BATT_SVC, BATT_LVL); setField('batt', b.getUint8(0)+'%'); }catch(e){ log('battery read: '+e.message,'err'); }
    for(const [ch,id] of [[DEV_MODEL,'model'],[DEV_FW,'fw'],[DEV_SERIAL,'serial'],[DEV_MFR,'mfr']]){
      try{ const v=await BleClient.read(deviceId, DEV_SVC, ch); setField(id, new TextDecoder().decode(v).replace(/\0/g,'').trim()); }catch(e){}
    }

    // live HR (standard service — works without the custom-service auth)
    try{
      await BleClient.startNotifications(deviceId, HR_SVC, HR_MEAS, (v)=>{
        const hr=parseHeartRate(v); lastHrAt=Date.now();
        setField('hr', hr); const r=rmssd(); setField('hrv', r==null?'—':r+' ms');
      });
      log('subscribed: live Heart Rate ✓','ok');
    }catch(e){ log('HR subscribe failed: '+e.message,'err'); }

    // custom command service (CoreBluetooth bonds/encrypts on demand — the iOS advantage)
    for(const [ch,label] of [[RX_CMD,'command_from_strap'],[RX_EVT,'events_from_strap'],[RX_DAT,'data_from_strap']]){
      try{ await BleClient.startNotifications(deviceId, SVC, ch, (v)=>logFrame('RX['+label+']', parseFrame(v)));
           log('subscribed: '+label+' ✓','ok'); }
      catch(e){ log('subscribe '+label+' FAILED: '+e.message,'err'); }
    }
    log('connected. Try get_hello.','ok');
  }catch(e){ log('connect error: '+e.message,'err'); setStatus('not connected'); }
}

async function send(command, data=[], label=''){
  if(!deviceId){ log('not connected','err'); return; }
  const frame = buildCommand(seq, command, data);
  try{
    await BleClient.write(deviceId, SVC, TX, numbersToDataView(frame));
    log(`TX ${label||command} seq=${seq}  ${hex(frame)}`,'cmd');
    seq=(seq+1)&0xFF; if(seq===0) seq=1;
  }catch(e){ log('TX failed: '+e.message,'err'); }
}

async function onDisconnect(){ setStatus('disconnected'); enable(false); log('device disconnected.','err'); }
function enable(on){
  for(const id of ['hello','battery','range','disconnect']) $(id).disabled=!on;
  $('connect').disabled=on;
}

function selfTest(){
  const built=hex(buildCommand(1,145,[0x01]));
  if(built==='aa0108000001e67123019101363e5c8d') log('self-test: protocol OK ✓','ok');
  else log('self-test FAILED: '+built,'err');
}

document.addEventListener('DOMContentLoaded', ()=>{
  SplashScreen.hide().catch(()=>{});
  selfTest();
  $('connect').onclick   = connect;
  $('hello').onclick     = ()=>send(145,[0x01],'get_hello');
  $('battery').onclick   = ()=>send(26,[],'get_battery_level');
  $('range').onclick     = ()=>send(34,[],'get_data_range');
  $('disconnect').onclick= async ()=>{ if(deviceId){ try{ await BleClient.disconnect(deviceId); }catch(e){} } };
  $('clear').onclick     = ()=>$('log').innerHTML='';
  enable(false);
});
