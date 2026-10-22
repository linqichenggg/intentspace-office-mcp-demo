/* Reuses the existing four-area pixel model. Drawing coordinates are relative:
 * no scale, inter-area navigation or corporate seat-ID mapping is asserted. */
export const layoutAreas = {
  meeting:{box:[-35,-15,1240,805],entry:[323,601]},
  east:{box:[65,165,1050,745],entry:[470,730]},
  west:{box:[-30,600,1020,1100],entry:[90,1170]},
  connect:{box:[-25,0,1160,1370],entry:[115,1260]}
};
// Stable simulation IDs keep existing bookings editable. D/E replace the former
// fictional C-04/M-02 graphics; they are not Bitkey's internal space IDs.
// Capacities follow the supplied spaces.csv, not the number of drawn chairs.
export const layoutRooms = [
  {id:'office-c04',name:'D',mapLabel:'D',capacity:4,point:[680,270],legacyName:'C-04',features:['monitor','whiteboard','quiet']},
  {id:'office-m02',name:'E',mapLabel:'E',capacity:6,point:[784,215],legacyName:'M-02',features:['monitor','video']},
  {id:'tsg-room-a',name:'A',mapLabel:'A',capacity:6,point:[586,570],features:['projector','window']},
  {id:'tsg-room-b',name:'B',mapLabel:'B',capacity:8,point:[450,450],features:['monitor','video']},
  {id:'tsg-room-c',name:'C',mapLabel:'C',capacity:8,point:[613,318],features:['monitor','window']},
  {id:'tsg-room-f',name:'F',mapLabel:'F',capacity:8,point:[852,342],features:['projector','video']},
  {id:'tsg-room-g',name:'G',mapLabel:'G',capacity:8,point:[916,432],features:['monitor','video']},
  {id:'tsg-room-i',name:'I',mapLabel:'I',capacity:8,point:[751,570],features:['monitor','projector']},
  {id:'tsg-room-x',name:'X',mapLabel:'X',capacity:30,point:[990,600],features:['monitor','projector','video']}
];
export function layoutPosition(zone, spaceId) {
  const area=layoutAreas[zone]??layoutAreas.meeting;
  const room=zone==='meeting'?layoutRooms.find(r=>r.id===spaceId):layoutSeats().find(r=>r.area===zone&&r.id===spaceId);
  const [x,y]=room?.point??area.entry,[left,top,width,height]=area.box;
  return {x:(x-left)/width*100,y:(y-top)/height*100,point:[x,y],placed:Boolean(room)};
}
let seatInventory;
export function layoutSeats() {
  if(seatInventory)return seatInventory;
  const multiply=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
  const identity=()=>[1,0,0,1,0,0],seats=[];
  for(const zone of ['east','west','connect']){
    const svg=renderOfficeLayout(zone).svg,stack=[identity()];
    for(const match of svg.matchAll(/<g\b[^>]*>|<\/g>/g)){
      const tag=match[0];
      if(tag.startsWith('</')){stack.pop();continue;}
      let matrix=stack.at(-1);
      for(const transform of (tag.match(/transform="([^"]*)"/)?.[1]??'').matchAll(/(translate|rotate|scale)\(([^)]+)\)/g)){
        const values=transform[2].trim().split(/[ ,]+/).map(Number);let local=identity();
        if(transform[1]==='translate'){local[4]=values[0];local[5]=values[1]??0;}
        if(transform[1]==='scale'){local[0]=values[0];local[3]=values[1]??values[0];}
        if(transform[1]==='rotate'){const radians=values[0]*Math.PI/180;local=[Math.cos(radians),Math.sin(radians),-Math.sin(radians),Math.cos(radians),0,0];}
        matrix=multiply(matrix,local);
      }
      stack.push(matrix);
      const id=tag.match(/data-seat-id="([^"]+)"/)?.[1];
      if(id){
        const number=Number(id.split('-').at(-1)),prefix={east:'E',west:'W',connect:'C'}[zone];
        const features=['area_'+zone,...(number%4===0?['window']:[]),...(number%3===0?['quiet']:[]),...(number%5!==0?['low_airflow']:[]),...(number%2===0?['monitor']:[])];
        seats.push({id,name:prefix+'-'+String(number).padStart(3,'0'),area:zone,point:[matrix[4],matrix[5]],kind:'desk',capacity:1,features,
          capacity_source:'simulation',features_source:'simulation',corporate_mapping:'unbound'});
      }
    }
  }
  seatInventory=seats;return seatInventory;
}
export function renderOfficeLayout(zone='meeting', locale='ja', states={}) {
  const activeMap=Object.hasOwn(layoutAreas,zone)?zone:'meeting';
  let seatNumber=0;
const rect=(x,y,w,h,fill,stroke='',sw=2)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${stroke?`stroke="${stroke}" stroke-width="${sw}"`:''}/>`;
const path=(d,fill,stroke='#627c77',sw=4)=>`<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="miter"/>`;
const text=(x,y,label,size=15,fill='#203f40')=>`<text x="${x}" y="${y}" fill="${fill}" font-family="system-ui,sans-serif" font-size="${size}" font-weight="700" text-anchor="middle">${label}</text>`;
const group=(x,y,contents,rotation=0)=>`<g transform="translate(${x} ${y}) rotate(${rotation})">${contents}</g>`;
function chair(x,y,r=0){const id=activeMap+'-seat-'+String(++seatNumber).padStart(3,'0');const bound=activeMap!=='meeting',status=states[id]??'available';const label=locale==='en'?(bound?'Simulated seat':'Unbound seat'):(bound?'模擬座席':'座席・ID未確認');return `<g class="layoutSeat ${bound?status:'unbound'}" tabindex="${activeMap==='meeting'?-1:seatNumber===1?0:-1}" role="button" data-seat-id="${id}" ${bound?`data-room="${id}"`:''} aria-label="${label} ${id}" transform="translate(${x} ${y}) rotate(${r})"><title>${id} / ${label}</title>${bound&&['suggested','in_progress','reserved'].includes(status)?`<circle r="18" class="seatHalo"/>`:''}<g transform="scale(.65)">${rect(-10,-10,20,21,'#24494c')+rect(-10,-11,20,16,'#64a2a0')+rect(-8,-10,16,4,'#a9d1bc')+rect(-7,6,4,5,'#314b4b')+rect(5,6,4,5,'#314b4b')}</g></g>`}
function stool(x,y){return chair(x,y)}
function unknown(x,y,w,h){return rect(x,y,w,h,'url(#unknown)','#c99a59',1)+text(x+w/2,y+h/2,(locale==='en'?'Obscured':'図面不明'),11,'#62452b')}
// Single-sided desks: chairs face the desk edge, following the staggered rows in the source.
function verticalRow(x,y,ys,side){let s=table(x,y,20,ys.length*40);ys.forEach(cy=>{s+=path(`M ${x} ${cy+20} H ${x+20}`,'none','#a58658',1)+chair(side==='right'?x+28:x-9,cy,side==='right'?90:-90)});return s}
function horizontalRow(x,y,xs,side){let s=table(x,y,125,20);xs.forEach(cx=>{s+=chair(cx,side==='below'?y+28:y-9,side==='below'?180:0)});return s}
function table(x,y,w,h){return rect(x+3,y+5,w,h,'#70573e')+rect(x,y,w,h,'#d6ae6e','#846849',3)+rect(x+3,y+3,w-6,4,'#f0d499')+rect(x+4,y+h-7,w-8,4,'#b58a50')}
function plant(x,y){return group(x,y,rect(-8,2,16,15,'#9b6848')+rect(-12,-13,24,18,'#458066')+rect(-7,-21,15,24,'#6eaa75')+rect(-4,-17,7,10,'#9bc382'))}
function workstation(x,y,n=5){let s=table(0,0,30,n*34);for(let i=0;i<n;i++){s+=rect(2,i*34+30,26,2,'#9c7c51')+chair(-15,i*34+16,90)+chair(45,i*34+16,-90)+rect(4,i*34+7,10,14,'#345d60')+rect(16,i*34+7,10,14,'#345d60')+rect(5,i*34+8,7,10,'#80bbb7')+rect(18,i*34+8,7,10,'#80bbb7')}return group(x,y,s)}
function conference(x,y,w,h,seats,rotation=0){let s=table(-w/2,-h/2,w,h);for(let i=0;i<seats;i++){const xx=-w/2+(i+.5)*w/seats;s+=chair(xx,-h/2-17)+chair(xx,h/2+17,180)}return group(x,y,s,rotation)}
function roundTable(x,y){return group(x,y,path('M -18 -24 H 18 V -18 H 25 V 18 H 18 V 24 H -18 V 18 H -25 V -18 H -18 Z','#d9b573','#8c714d',3)+chair(0,-42)+chair(42,0,90)+chair(0,42,180)+chair(-42,0,-90))}
function sofa(x,y,w=80,r=0){return group(x,y,rect(3,4,w,35,'#1c4245')+rect(0,0,w,30,'#568f8a')+rect(0,0,w,7,'#98beb0')+rect(0,0,7,30,'#7bb0a1')+rect(w-7,0,7,30,'#7bb0a1')+rect(w/2,8,2,19,'#386e6b'),r)}
function floor(d){return path(d,'#11292d','#11292d',18)+path(d,'url(#floor)','#a9bcb0',6)}
function label(x,y,t){return rect(x-t.length*5-9,y-19,t.length*10+18,27,'#ecdfb4')+text(x,y,t,14)}
function room(name,d,contents,lx,ly){
  const item=layoutRooms.find(r=>r.mapLabel===name),id=item?.id??'unbound-h';
  const status=states[id]??'unknown',label=locale==='en'?'Room':'会議室';
  const capacity=item?String(item.capacity)+(locale==='en'?' seats':'人'):'?';
  const captions=locale==='en'?{available:'Free now',reserved:'Booked, not started',in_progress:'In use',suggested:'Candidate',unknown:'Unbound'}:{available:'現在空き',reserved:'予約あり・未開始',in_progress:'使用中',suggested:'候補',unknown:'未確認'};
  return `<g class="layoutRoom ${status}" tabindex="0" role="button" data-room="${id}" aria-label="${label} ${name} / ${capacity} / ${captions[status]}"><title>${label} ${name} / ${capacity} / ${captions[status]}</title>${path(d,'url(#room)','#b4c7bb',6)}${contents}<g class="roomMarker">${rect(lx-28,ly-22,56,42,'#284c4f')}${text(lx,ly,name,23,'#f6e7bd')}${text(lx,ly+15,capacity,11,'#f6e7bd')}</g></g>`;
}
function meeting(){let s=floor('M 6 584 L 718 30 L 1161 598 L 1004 720 L 941 720 L 855 656 L 58 656 Z');
 s+=room('B','M 326 418 L 475 301 L 549 396 L 397 513 Z',conference(435,407,117,42,5,-38),438,355);
 s+=room('C','M 532 276 L 603 222 L 664 301 L 595 356 Z',group(597,290,roundTable(0,0),52),597,291);
 s+=room('D','M 607 220 L 674 166 L 736 246 L 667 299 Z',group(672,231,roundTable(0,0),52),672,232);
 s+=room('E','M 677 162 L 743 111 L 718 78 L 742 60 L 852 211 L 770 284 Z',conference(773,196,73,36,3,52),738,139);
 s+=room('F','M 717 339 L 849 235 L 925 313 L 786 421 Z',conference(822,329,110,39,4,-38),771,318);
 s+=room('G','M 789 424 L 928 316 L 998 407 L 853 514 Z',conference(884,418,112,40,4,-38),839,407);
 s+=room('H','M 585 441 L 668 376 L 754 485 L 700 528 L 651 528 Z','',673,468);
 s+=room('A','M 475 530 L 509 503 L 530 530 L 629 530 L 629 657 L 475 657 Z',conference(551,598,99,38,4),551,600);
 s+=room('I','M 633 532 L 701 532 L 757 489 L 785 529 L 785 657 L 633 657 Z',conference(709,598,99,38,4),709,600);
 let xRoom=table(943,504,24,145)+table(981,504,24,145)+table(945,637,57,21);for(let i=0;i<7;i++)xRoom+=chair(926,503+i*24,-90)+chair(1023,503+i*24,90);xRoom+=chair(959,674,180)+chair(987,674,180);
 for(const [x,y]of [[875,578],[880,628],[910,679],[974,707],[1038,679],[1074,628],[1074,578]])xRoom+=stool(x,y);
 s+=room('X','M 855 514 L 939 449 L 1034 449 L 1093 523 L 1093 652 L 1007 719 L 943 719 L 858 652 Z',xRoom,974,474);
 s+=label(323,601,(locale==='en'?'Entry':'入口'))+path('M 276 562 H 318 V 550 L 343 570 L 318 590 V 578 H 276 Z','#64a2a0','none');return s}
function east(){let s=floor('M 103 204 H 1075 V 868 H 466 V 809 H 411 V 750 H 190 V 682 H 103 Z');
 // Ten aisles. Each has FIVE chairs on each side; the facing rows are offset vertically.
 for(const [left,right] of [[128,195],[216,283],[304,371],[392,459],[480,547],[568,635],[656,723],[744,811],[832,899],[920,987]]){
   s+=verticalRow(left,276,[287,327,367,407,447],'right');
   s+=verticalRow(right,276,[301,341,381,421,461],'left');
 }
 // Three short aisles beside the enclosed lounge (four chairs on each side).
 for(const [left,right] of [[270,331],[353,417],[439,502]]){
   s+=verticalRow(left,525,[561,595,630,664],'right');
   s+=verticalRow(right,525,[548,582,617,651],'left');
 }
 // Five long aisles at the lower right, followed by five short aisles below the passage.
 for(const [left,right] of [[567,633],[655,721],[743,809],[831,897],[919,985]]){
   s+=verticalRow(left,526,[565,605,645,685,725],'right');
   s+=verticalRow(right,526,[551,591,631,671,711],'left');
   s+=verticalRow(left,771,[810,850],'right');
   s+=verticalRow(right,771,[796,836],'left');
 }
 s+=path('M 173 527 H 265 V 681 H 173 Z','#e2d5b2','#a9bcb0',4);
 s+=rect(177,532,35,36,'#9eaa98')+rect(194,572,19,87,'#80a497')+rect(244,538,18,137,'#80a497')+rect(195,660,67,16,'#80a497');
 for(const [x,y]of [[239,565],[200,597],[239,597],[200,631],[239,631],[221,653]])s+=stool(x,y);
 s+=table(503,792,25,59);for(const y of [799,821,843])s+=chair(492,y,-90)+chair(536,y,90);
 s+=path('M 192 685 H 463 V 744 H 192 Z','#e7e8dc','#a9bcb0',4);
 // Facilities are drawn as cabinets, not invented seats; app icons hide some fixtures.
 for(const x of [220,240,260,280,300,320,340,360,380])s+=rect(x,206,18,42,'#8a9b8f','#617d72');
 s+=unknown(106,206,87,43)+unknown(636,207,174,41);
 for(const [x,y]of [[288,244],[332,244],[448,240],[493,240],[539,240],[584,240],[894,234],[945,234],[997,234],[1047,354],[1047,415],[1046,496],[1047,548]])s+=chair(x,y,45);
 s+=unknown(1038,243,36,83)+unknown(1038,571,36,78);
 s+=label(760,514,(locale==='en'?'Aisle':'通路'));return s}
function west(){let s=floor('M 0 634 H 946 V 1126 H 610 V 1515 H 737 V 1664 H 0 Z');
 // U-shaped counter with inward-facing individual desks, NOT a single conference table.
 s+=path('M 41 701 H 429 V 937 H 41 Z','#e3d6b5','#b1c3b6',4);
 s+=table(117,736,250,25)+table(117,761,24,164)+table(342,761,25,164);
 for(const x of [117,159,201,243,285,326,367])s+=stool(x,720);
 for(const y of [747,781,814,848,880,915])s+=stool(77,y)+stool(402,y);
 for(const y of [762,806,849,893]){s+=table(140,y,24,27)+table(316,y,25,27)}
 for(const [x,y]of [[174,895],[174,915],[201,871],[201,895],[280,871],[280,895],[308,873],[308,915]])s+=chair(x,y,90);
 s+=table(218,868,52,58)+unknown(183,763,106,104);
 // Five full staggered aisles and a visibly cut-off row at the right screenshot boundary.
 for(const [left,right]of [[438,498],[529,590],[620,680],[711,771],[802,862]]){
   s+=verticalRow(left,705,[718,760,802,844,886],'right');
   s+=verticalRow(right,705,[734,776,817,859,900],'left');
 }
 s+=verticalRow(893,705,[718,760,802,844,886],'right');
 // Middle-left: two columns, four single-sided desk rows (24 visible chairs).
 for(const x of [117,249]){
   s+=horizontalRow(x,968,[x+14,x+56,x+98],'below');
   s+=horizontalRow(x,1040,[x+29,x+71,x+113],'above');
   s+=horizontalRow(x,1063,[x+14,x+56,x+98],'below');
   s+=horizontalRow(x,1137,[x+29,x+71,x+113],'above');
 }
 s+=path('M 512 967 H 905 V 1123 H 610 V 1190 H 442 V 1120 H 512 Z','#dfd2b0','#b1c3b6',4);
 s+=table(550,1031,54,35);for(const x of [567,591])s+=stool(x,1025)+stool(x,1072);
 for(const x of [657,741,824]){s+=table(x,1004,35,51);for(const y of [1017,1041])s+=stool(x-7,y)+stool(x+42,y)}
 s+=horizontalRow(120,1215,[133,175,217],'below')+horizontalRow(120,1281,[148,190,232],'above');
 s+=table(150,1348,42,147);for(const y of [1357,1381,1405,1429,1453,1477])s+=chair(139,y,-90)+chair(207,y,90);
 for(const [x,y]of [[139,1513],[171,1504],[213,1513]])s+=chair(x,y);
 // Lower right room: retain the four visible rows; the app badge covers the middle.
 for(const x of [272,314,355])s+=chair(x,1275,180)+chair(x,1316)+chair(x,1463,180);
 for(const x of [272,304,337])s+=chair(x,1506);
 s+=table(256,1261,117,8)+table(256,1327,117,21)+table(256,1447,117,8)+table(256,1517,101,14)+unknown(256,1344,118,105);
 for(let y=1238;y<1585;y+=35)s+=rect(438,y,68,33,'#829185','#597368',2); // storage bank, no seats
 for(const y of [1257,1330,1400,1490,1558])s+=rect(547,y,53,26,'#9eaa98');
 for(const [x,y]of [[42,670],[82,670],[122,670],[162,670],[202,670],[269,670],[317,670],[363,670],[410,670],[696,659],[732,659],[767,659],[802,659],[838,659],[922,665],[16,756],[16,804]])s+=chair(x,y);
 s+=unknown(465,636,181,44)+unknown(249,1214,131,40);
 s+=path('M 287 1590 L 384 1590 L 335 1660 Z','#d6b477','#8f7653',3);
 for(const [x,y]of [[337,1576],[292,1637],[380,1635],[303,1658],[369,1658]])s+=stool(x,y);
 // Left-edge rooms are partially visible; keep their visible furniture and mark only the cropped edge.
 for(const y of [1103,1216])s+=path(`M 0 ${y} H 72 V ${y+106} H 0`,'#dfd2b0','#b1c3b6',3)+table(18,y+16,15,48)+chair(4,y+40,-90);
 s+=path('M 0 1342 H 73 V 1497 H 0','#dfd2b0','#b1c3b6',3)+table(28,1375,20,47)+table(8,1438,46,16)+rect(0,1347,62,20,'#80a497');
 s+=path('M 0 1525 H 78 V 1637 H 0','#dfd2b0','#b1c3b6',3)+table(1,1554,38,32)+chair(9,1600)+table(79,1580,16,53)+table(100,1615,68,20)+chair(112,1619)+chair(152,1619);
 s+=unknown(0,997,9,638);return s}
function connect(){let s=floor('M 16 40 H 1081 V 289 L 254 1310 H 16 Z');
 s+=path('M 129 48 V 1300','none','#9aac9c',3);
 // Top counter: seven visible seats, with gaps between desk sections.
 for(const [x,w]of [[45,77],[153,40],[217,40],[279,76],[385,39]])s+=table(x,81,w,35);
 for(const x of [66,102,173,241,298,338,405])s+=chair(x,136,180);
 // Wall-side lounge seats and their small circular tables.
 for(const [x,y]of [[77,218],[65,338],[65,394],[65,472],[65,528],[86,730],[86,807],[65,1034],[65,1089],[65,1172],[65,1244]])s+=chair(x,y,90);
 for(const [x,y]of [[37,365],[37,499],[33,1050],[33,1119],[33,1191],[33,1261]])s+=rect(x-12,y-12,24,24,'#d3b57a','#8c754f');
 for(let y=611;y<925;y+=36)s+=rect(17,y,77,32,'#81998e','#56776a');
 s+=table(216,206,38,83)+sofa(300,202,80,90)+sofa(412,217,118)+sofa(396,267,108,90)+sofa(412,374,118)+table(426,284,38,81)+table(471,284,38,81);
 for(const [x,y]of [[187,220],[187,274],[554,296],[553,345],[629,338],[629,394],[529,501],[529,555],[159,769],[201,811]])s+=chair(x,y,90);
 for(const [x,y]of [[671,365],[564,531],[202,765]])s+=rect(x-16,y-16,32,32,'#d3b57a','#8c754f');
 for(const [x,y]of [[740,220],[883,332],[180,1105]]){
   s+=group(x,y,path('M -18 -24 H 18 L 25 -18 V 18 L 18 24 H -18 L -25 18 V -18 Z','#d9b573','#8c714d',2));
   for(const [dx,dy,r]of [[-29,-29,-45],[29,-29,45],[-29,29,-135],[29,29,135]])s+=chair(x+dx,y+dy,r);
 }
 // Central long table: six stools are visible near the lower end only.
 s+=path('M 607 662 L 799 409 L 841 441 L 640 690 Z','#d6ae6e','#846849',3);
 for(const [x,y]of [[656,569],[633,598],[610,628],[713,622],[691,652],[669,681]])s+=chair(x,y,38);
 // Triangular tables are in alternating orientations inside the structural grid.
 for(const d of ['M 332 548 L 394 475 L 438 570 Z','M 207 646 L 306 635 L 259 718 Z','M 389 724 L 466 638 L 505 704 Z','M 232 813 L 295 751 L 331 823 Z','M 274 856 L 341 777 L 376 863 Z','M 212 1014 L 251 920 L 313 956 Z'])s+=path(d,'#d6ae6e','#846849',2);
 for(const [x,y,r]of [[350,490,0],[438,497,0],[451,526,90],[328,518,-90],[359,584,180],[396,586,180],[225,646,-45],[317,685,90],[297,717,90],[390,653,-45],[512,666,45],[464,625,0],[375,718,180],[471,724,180],[286,774,0],[263,805,-45],[372,775,45],[389,813,90],[294,871,180],[329,875,180],[199,929,-45],[289,968,45],[269,997,45]])s+=chair(x,y,r);
 // The dark triangles in the reference are structural lines, not additional desks.
 s+=path('M 164 1040 V 375 H 532 L 590 489 L 504 598 H 164 L 252 375 L 438 598 M 164 709 H 406 L 504 598 M 164 932 H 246 L 406 709 M 164 1040 L 504 598 M 164 489 L 252 375 M 164 598 L 310 489 H 590 M 164 709 L 221 598 L 331 821 H 164 M 246 932 L 164 709','none','#6b786a',2);
 // Bottom diagonal counter: seats are on the inside edge only.
 s+=path('M 357 1113 L 624 767 L 651 788 L 384 1136 Z','#b6c4af','#6b877b',3);
 for(const [x,y]of [[552,766],[528,796],[484,852],[443,906],[407,953],[383,982],[342,1037]]){s+=group(x+26,y+23,table(-19,-20,38,40),38)+chair(x,y,38)}
 s+=path('M 817 114 H 981 V 243 Z','#dbb779','#876c49',3);for(const [x,y]of [[843,152],[871,174],[906,201],[937,223]])s+=chair(x,y,-52);
 s+=rect(1042,42,37,247,'#9aab9c','#648174');
 for(const [x,y]of [[538,167],[685,286],[836,400]])s+=group(x,y,rect(-48,-9,96,18,'#a8b79f'),38);
 s+=path('M 578 40 L 670 40 L 625 134 Z','#d6b477','#8f7653',3)+stool(573,73)+stool(684,69);
 return s}

  return {box:layoutAreas[activeMap].box,svg:`<defs><pattern id="floor" width="48" height="32" patternUnits="userSpaceOnUse"><rect width="48" height="32" fill="#dfcc9d"/><path d="M 0 0 H 48 M 0 16 H 48 M 24 0 V 16 M 0 16 V 32" fill="none" stroke="#cbb786" stroke-width="1"/></pattern><pattern id="room" width="24" height="24" patternUnits="userSpaceOnUse"><rect width="24" height="24" fill="#e3dbc0"/><path d="M 0 0 H 24 V 24" fill="none" stroke="#d3cbb1"/></pattern><pattern id="unknown" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#e5c89a"/><path d="M 0 8 L 8 0" stroke="#ba9867"/></pattern></defs>${({meeting,east,west,connect})[activeMap]()}`,seatCount:seatNumber};
}

