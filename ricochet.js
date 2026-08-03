'use strict';

// Ricochets are deliberately deterministic and stateless. The server owns the
// result; clients use the same small ruleset only to render smoothly between
// authoritative updates.
const WEAPON_RICOCHETS = Object.freeze({
  pistol:1,
  shotgun:1,
  smg:1,
  sniper:2,
});

const EPSILON = 0.08;
const MIN_T = 1e-7;

function ricochetsForWeapon(weapon) {
  return WEAPON_RICOCHETS[weapon] ?? WEAPON_RICOCHETS.pistol;
}

function segmentAabbHit(x,y,dx,dy,minX,minY,maxX,maxY) {
  let near=0;
  let far=1;
  let normalX=0;
  let normalY=0;

  // This function runs for every active bullet against every obstacle. Keep it
  // allocation-free on misses so a crowded room does not create avoidable GC
  // pauses that delay movement snapshots and ping replies.
  if (Math.abs(dx)<1e-12) {
    if (x<minX||x>maxX) return null;
  } else {
    let t1=(minX-x)/dx;
    let t2=(maxX-x)/dx;
    let enterX=-1;
    if(t1>t2){const swap=t1;t1=t2;t2=swap;enterX=1;}
    if(t1>near){near=t1;normalX=enterX;normalY=0;}
    far=Math.min(far,t2);
    if(near>far)return null;
  }

  if (Math.abs(dy)<1e-12) {
    if (y<minY||y>maxY) return null;
  } else {
    let t1=(minY-y)/dy;
    let t2=(maxY-y)/dy;
    let enterY=-1;
    if(t1>t2){const swap=t1;t1=t2;t2=swap;enterY=1;}
    if(t1>near){near=t1;normalX=0;normalY=enterY;}
    else if(Math.abs(t1-near)<1e-9&&t1>MIN_T){normalY+=enterY;}
    far=Math.min(far,t2);
    if(near>far)return null;
  }

  if (near<MIN_T||near>1) return null;
  const normalLength=Math.hypot(normalX,normalY)||1;
  return {t:near,nx:normalX/normalLength,ny:normalY/normalLength};
}

function earliestCollision(bullet,obstacles,worldW,worldH) {
  const r=Math.max(0,Number(bullet.r)||0);
  const x=Number(bullet.x)||0;
  const y=Number(bullet.y)||0;
  const dx=Number(bullet.vx)||0;
  const dy=Number(bullet.vy)||0;
  let best=null;

  const consider=hit=>{
    if (!hit) return;
    if (!best||hit.t<best.t-1e-9) {
      best=hit;
      return;
    }
    // Treat an exact arena/obstacle corner as one diagonal surface. Without
    // this, the X edge could consume one bounce and the Y edge another on the
    // following tick, which made corner shots disappear unexpectedly.
    if (Math.abs(hit.t-best.t)<=1e-9) {
      const nx=best.nx+hit.nx;
      const ny=best.ny+hit.ny;
      const length=Math.hypot(nx,ny);
      if (length>1e-9) {
        best={
          ...best,
          nx:nx/length,
          ny:ny/length,
          type:best.type==='wall'||hit.type==='wall'?'wall':'border',
        };
      }
    }
  };

  if (dx<0&&x+dx<r) consider({t:(r-x)/dx,nx:1,ny:0,type:'border'});
  if (dx>0&&x+dx>worldW-r) consider({t:(worldW-r-x)/dx,nx:-1,ny:0,type:'border'});
  if (dy<0&&y+dy<r) consider({t:(r-y)/dy,nx:0,ny:1,type:'border'});
  if (dy>0&&y+dy>worldH-r) consider({t:(worldH-r-y)/dy,nx:0,ny:-1,type:'border'});

  for (const obstacle of obstacles||[]) {
    if (!obstacle) continue;
    const minX=obstacle.x-r;
    const minY=obstacle.y-r;
    const maxX=obstacle.x+obstacle.w+r;
    const maxY=obstacle.y+obstacle.h+r;
    // A muzzle can begin a few pixels inside an expanded wall when a player is
    // pressed against it. Project back to the nearest face so the shot banks
    // instead of tunnelling through the obstacle.
    if (x>=minX&&x<=maxX&&y>=minY&&y<=maxY) {
      let distance=x-minX,nx=-1,ny=0,impactX=minX,impactY=y;
      const right=maxX-x;
      if(right<distance){distance=right;nx=1;ny=0;impactX=maxX;impactY=y;}
      const top=y-minY;
      if(top<distance){distance=top;nx=0;ny=-1;impactX=x;impactY=minY;}
      const bottom=maxY-y;
      if(bottom<distance){nx=0;ny=1;impactX=x;impactY=maxY;}
      consider({t:0,nx,ny,impactX,impactY,type:'wall'});
      continue;
    }
    const hit=segmentAabbHit(
      x,y,dx,dy,
      minX,minY,maxX,maxY
    );
    if (hit) consider({...hit,type:'wall'});
  }
  return best;
}

function stepBullet(bullet,obstacles,{worldW,worldH}={}) {
  if (!bullet||!Number.isFinite(worldW)||!Number.isFinite(worldH)) {
    return {removed:true,bounced:false};
  }
  const hit=earliestCollision(bullet,obstacles,worldW,worldH);
  if (!hit) {
    bullet.x+=bullet.vx;
    bullet.y+=bullet.vy;
    return {removed:false,bounced:false};
  }

  const impactX=Number.isFinite(hit.impactX)?hit.impactX:bullet.x+bullet.vx*hit.t;
  const impactY=Number.isFinite(hit.impactY)?hit.impactY:bullet.y+bullet.vy*hit.t;
  if ((Number(bullet.bouncesLeft)||0)<=0) {
    bullet.x=impactX;
    bullet.y=impactY;
    return {removed:true,bounced:false,impact:{x:impactX,y:impactY,nx:hit.nx,ny:hit.ny,type:hit.type}};
  }

  const dot=bullet.vx*hit.nx+bullet.vy*hit.ny;
  const reflectedX=bullet.vx-2*dot*hit.nx;
  const reflectedY=bullet.vy-2*dot*hit.ny;
  const remaining=Math.max(0,1-hit.t);
  bullet.vx=reflectedX;
  bullet.vy=reflectedY;
  bullet.bouncesLeft-=1;
  bullet.bounceCount=(Number(bullet.bounceCount)||0)+1;
  bullet.x=impactX+hit.nx*EPSILON+reflectedX*remaining;
  bullet.y=impactY+hit.ny*EPSILON+reflectedY*remaining;
  bullet.x=Math.max(bullet.r||0,Math.min(worldW-(bullet.r||0),bullet.x));
  bullet.y=Math.max(bullet.r||0,Math.min(worldH-(bullet.r||0),bullet.y));

  return {
    removed:false,
    bounced:true,
    impact:{x:impactX,y:impactY,nx:hit.nx,ny:hit.ny,type:hit.type},
    bounceCount:bullet.bounceCount,
  };
}

function killPointsForBounces(bounces) {
  const count=Math.max(0,Math.floor(Number(bounces)||0));
  if (count>=2) return 225;
  if (count===1) return 150;
  return 100;
}

module.exports={
  WEAPON_RICOCHETS,
  ricochetsForWeapon,
  segmentAabbHit,
  earliestCollision,
  stepBullet,
  killPointsForBounces,
};
