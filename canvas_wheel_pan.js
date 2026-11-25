import { app } from "../../scripts/app.js";

export function panCanvasWheel(canvas,event){
  if(!canvas?.ds||event.target!==canvas.canvas||(!event.shiftKey&&!event.ctrlKey)||event.metaKey||event.altKey)return false;
  const rect=canvas.canvas.getBoundingClientRect();
  const axis=event.ctrlKey?0:1;
  const delta=event.deltaY||event.deltaX;
  if(!delta||!rect.width||!rect.height||!(canvas.ds.scale>0))return false;
  const pixels=delta*(event.deltaMode===1?16:event.deltaMode===2?(axis?rect.height:rect.width):1);
  const ratio=canvas.ds.scale;
  canvas.ds.offset[axis]-=pixels/ratio;
  event.preventDefault();event.stopImmediatePropagation();
  canvas.setDirty(true,true);
  return true;
}

app.registerExtension({
  name:'liuxinyu.CanvasWheelPan',
  setup(){
    // Window capture runs before canvas widgets' document-level scrolling.
    window.addEventListener('wheel',event=>panCanvasWheel(app.canvas,event),{capture:true,passive:false});
  },
});
