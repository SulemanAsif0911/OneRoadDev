// High-res design map: drivable(clearance tint) + buildings + props + painted streets, 10m grid
import fs from 'fs';
import {png,newImage,text,line,rect,blit} from '/home/user/tools/pngutil.mjs';
const meta=JSON.parse(fs.readFileSync('public/arena/meta.json','utf8')); const buf=fs.readFileSync('public/arena/grid.bin');
const props=JSON.parse(fs.readFileSync('public/arena/props.json','utf8'));
const {nx,nz,res,x0,z0,x1,z1}=meta; const H=new Float32Array(nx*nz),B=new Uint8Array(nx*nz),F=new Uint8Array(nx*nz);
for(let k=0;k<nx*nz;k++){H[k]=buf.readInt16LE(k*4)*meta.quant;B[k]=buf.readUInt8(k*4+2);F[k]=buf.readUInt8(k*4+3);}
const drv=new Uint8Array(nx*nz); for(let k=0;k<nx*nz;k++){ if(H[k]<-900||B[k]||(F[k]&2))continue; drv[k]=1; }
const INF=1e9; const clr=new Float32Array(nx*nz);
for(let k=0;k<nx*nz;k++)clr[k]=drv[k]?INF:0;
const d1=1,d2=Math.SQRT2;
for(let z=0;z<nz;z++)for(let x=0;x<nx;x++){const k=z*nx+x;if(clr[k]===0)continue;let v=clr[k];
 if(x>0)v=Math.min(v,clr[k-1]+d1); if(z>0)v=Math.min(v,clr[k-nx]+d1); if(x>0&&z>0)v=Math.min(v,clr[k-nx-1]+d2); if(x<nx-1&&z>0)v=Math.min(v,clr[k-nx+1]+d2); clr[k]=v;}
for(let z=nz-1;z>=0;z--)for(let x=nx-1;x>=0;x--){const k=z*nx+x;if(clr[k]===0)continue;let v=clr[k];
 if(x<nx-1)v=Math.min(v,clr[k+1]+d1); if(z<nz-1)v=Math.min(v,clr[k+nx]+d1); if(x<nx-1&&z<nz-1)v=Math.min(v,clr[k+nx+1]+d2); if(x>0&&z<nz-1)v=Math.min(v,clr[k+nx-1]+d2); clr[k]=v;}
for(let k=0;k<nx*nz;k++)clr[k]*=res;
const CROP=(process.env.CROP||'-110,60,-95,45').split(',').map(Number);
const PPM=+(process.env.PPM||6);
const cw=Math.round((CROP[1]-CROP[0])*PPM), ch=Math.round((CROP[3]-CROP[2])*PPM);
const img=newImage(cw,ch,[10,12,20]);
for(let py=0;py<ch;py++)for(let px=0;px<cw;px++){
  const wx=CROP[0]+px/PPM, wz=CROP[2]+py/PPM;
  const gx=Math.floor((wx-x0)/res), gz=Math.floor((wz-z0)/res); if(gx<0||gz<0||gx>=nx||gz>=nz)continue;
  const k=gz*nx+gx,i=(py*cw+px)*4;
  if(H[k]<-900){img.px[i]=6;img.px[i+1]=8;img.px[i+2]=14;continue;}
  if(B[k]){img.px[i]=150;img.px[i+1]=70;img.px[i+2]=50;continue;}      // building / wall
  if(F[k]&2){img.px[i]=36;img.px[i+1]=40;img.px[i+2]=52;continue;}     // steep terrain
  const t=Math.min(1,clr[k]/14);
  img.px[i]=Math.round(18+t*40);img.px[i+1]=Math.round(50+t*110);img.px[i+2]=Math.round(38+t*90);
  if(F[k]&1){img.px[i]=Math.round(img.px[i]*0.45+30*0.55);img.px[i+1]=Math.round(img.px[i+1]*0.45+120*0.55);img.px[i+2]=Math.round(img.px[i+2]*0.45+150*0.55);}
}
// props as dots
for(const [px_,pz,r,h,y] of props){
  const sx=Math.round((px_-CROP[0])*PPM), sy=Math.round((pz-CROP[2])*PPM);
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const x=sx+dx,y2=sy+dy;if(x<0||y2<0||x>=cw||y2>=ch)continue;const i=(y2*cw+x)*4;img.px[i]=255;img.px[i+1]=255;img.px[i+2]=255;}
}
for(let m=Math.ceil(CROP[0]/10)*10;m<=CROP[1];m+=10){const px=Math.round((m-CROP[0])*PPM);if(px<0||px>=cw)continue;line(img,px,0,px,ch-1,[255,255,255],m%50===0?0.4:0.16);text(img,String(m),px+2,2,m%50===0?[255,235,140]:[190,200,220],1);}
for(let m=Math.ceil(CROP[2]/10)*10;m<=CROP[3];m+=10){const py=Math.round((m-CROP[2])*PPM);if(py<0||py>=ch)continue;line(img,0,py,cw-1,py,[255,255,255],m%50===0?0.4:0.16);text(img,String(m),2,py+2,m%50===0?[255,235,140]:[190,200,220],1);}
const o2=newImage(cw,ch+30,[10,12,20]); blit(o2,img,0,26);
text(o2,`DESIGN MAP x[${CROP[0]},${CROP[1]}] z[${CROP[2]},${CROP[3]}] ${PPM}px/m  GREEN=drivable(clearance tint) ORANGE=building/blocked WHITE=prop grey=steep`,4,3,[235,245,255],1);
text(o2,`baked: S=${meta.metersPerUnit}m per unit, ${nx}x${nz} grid @${res}m, obstacle>${2.0}m blocks`,4,15,[190,210,235],1);
fs.writeFileSync(process.env.OUT||'/home/user/shots/design.png',png(o2.w,o2.h,o2.px));
console.log('saved',cw+'x'+ch);
