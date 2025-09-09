// effects-v2.js
let spinAudio, cheerAudio;
let lastAngle=0, maxDelta=0;

function initAudio() {
  spinAudio = new Audio('/bike-loop-103290.mp3');
  spinAudio.loop=true;
  cheerAudio = new Audio('/applause-01-253125.mp3');
}

export function startSpin() {
  if (!spinAudio) initAudio();
  spinAudio.currentTime=0;
  spinAudio.volume=0.9;
  spinAudio.playbackRate=1.6;
  spinAudio.play().catch(()=>{});
}

export function tick(angle) {
  if (!spinAudio) return;
  let delta=angle-lastAngle;
  if (delta>180) delta-=360;
  if (delta<-180) delta+=360;
  const speed=Math.abs(delta);
  if (speed>maxDelta) maxDelta=speed||maxDelta;
  const baseline=maxDelta||1;
  const ratio=Math.min(1,Math.max(0,speed/baseline));
  const rate=0.5+ratio*1.3;
  spinAudio.playbackRate=rate;
  lastAngle=angle;
}

export function stopSpinSound() {
  if (spinAudio){ spinAudio.pause(); spinAudio.currentTime=0; }
}

export function onWin({prize,rare}) {
  stopSpinSound();
  if (!cheerAudio) initAudio();
  cheerAudio.currentTime=0;
  cheerAudio.volume=1.0;
  cheerAudio.play().catch(()=>{});
  startCelebrationBehind();
  if (rare) startFrontCelebration();
}

/* Celebration behind */
function startCelebrationBehind(duration=8000) {
  const canvas=document.createElement('canvas');
  canvas.id='celebration-canvas';
  document.body.appendChild(canvas);
  const ctx=canvas.getContext('2d');
  canvas.width=innerWidth; canvas.height=innerHeight;
  let blobs=[];
  function rand(min,max){return Math.random()*(max-min)+min;}
  class Blob{constructor(){
    this.x=rand(0,canvas.width); this.y=rand(0,canvas.height);
    this.vx=rand(-3,3); this.vy=rand(-3,3); this.r=2; this.h=Math.random()*360;
  }
  update(){this.x+=this.vx; this.y+=this.vy; if(this.x<0||this.x>canvas.width)this.vx*=-1; if(this.y<0||this.y>canvas.height)this.vy*=-1;}
  draw(){ctx.beginPath();ctx.arc(this.x,this.y,this.r,0,Math.PI*2);ctx.fillStyle=`hsl(${this.h},100%,50%)`;ctx.fill();}}
  for(let i=0;i<100;i++) blobs.push(new Blob());
  let stopAt=Date.now()+duration;
  function loop(){ctx.clearRect(0,0,canvas.width,canvas.height);blobs.forEach(b=>{b.update();b.draw();}); if(Date.now()<stopAt) requestAnimationFrame(loop); else canvas.remove();}
  loop();
}

/* Celebration front */
function startFrontCelebration(duration=6000) {
  const canvas=document.createElement('canvas');
  canvas.id='front-celebration';
  document.body.appendChild(canvas);
  const ctx=canvas.getContext('2d');
  canvas.width=innerWidth; canvas.height=innerHeight;
  let particles=[];
  for(let i=0;i<300;i++) particles.push({
    x:canvas.width/2,y:canvas.height/2,
    vx:(Math.random()*6-3),vy:(Math.random()*6-3),
    life:duration, color:`hsl(${Math.random()*360},100%,50%)`
  });
  function loop(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    particles.forEach(p=>{
      p.x+=p.vx; p.y+=p.vy; p.life-=16;
      ctx.fillStyle=p.color; ctx.fillRect(p.x,p.y,3,3);
    });
    particles=particles.filter(p=>p.life>0);
    if(particles.length) requestAnimationFrame(loop); else canvas.remove();
  }
  loop();
}
