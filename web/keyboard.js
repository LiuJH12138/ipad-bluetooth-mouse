'use strict';
(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.IpadKeyboard=api;})(globalThis,()=>{
  const codes={Enter:40,Escape:41,Backspace:42,Tab:43,Space:44,Minus:45,Equal:46,BracketLeft:47,BracketRight:48,Backslash:49,Semicolon:51,Quote:52,Backquote:53,Comma:54,Period:55,Slash:56,CapsLock:57,PrintScreen:70,ScrollLock:71,Pause:72,Insert:73,Home:74,PageUp:75,Delete:76,End:77,PageDown:78,ArrowRight:79,ArrowLeft:80,ArrowDown:81,ArrowUp:82,NumLock:83,NumpadDivide:84,NumpadMultiply:85,NumpadSubtract:86,NumpadAdd:87,NumpadEnter:88,Numpad0:98,NumpadDecimal:99,IntlBackslash:100,ContextMenu:101};
  for(let i=0;i<26;i++)codes['Key'+String.fromCharCode(65+i)]=4+i;
  for(let i=1;i<=9;i++){codes['Digit'+i]=29+i;codes['Numpad'+i]=88+i;}codes.Digit0=39;
  for(let i=1;i<=12;i++)codes['F'+i]=57+i;
  const modifiers={ControlLeft:1,ShiftLeft:2,AltLeft:4,MetaLeft:8,ControlRight:16,ShiftRight:32,AltRight:64,MetaRight:128};
  class KeyboardState {
    constructor(){this.pressed=new Set();this.commandControl=true;}
    clear(){this.pressed.clear();return this.report();}
    change(code,down){if(!(code in codes)&&!(code in modifiers))return null;if(down)this.pressed.add(code);else this.pressed.delete(code);return this.report();}
    report(){let modifier=0;const keys=[];for(const code of this.pressed){if(code in modifiers){let value=modifiers[code];if(this.commandControl&&code==='ControlLeft')value=8;if(this.commandControl&&code==='ControlRight')value=128;modifier|=value;}else if(keys.length<6)keys.push(codes[code]);}return{modifiers:modifier,keys};}
  }
  return{KeyboardState};
});