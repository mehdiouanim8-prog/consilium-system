(function(){'use strict';
function init(){
 const i18n=window.ConsiliumI18n;if(!i18n)return;
 const selector=document.getElementById('language-selector');
 const gate=document.getElementById('language-gate');
 const isHome=!!gate;
 const buttons=document.querySelectorAll('[data-language]');
 const choose=(lang)=>{i18n.setLanguage(lang);document.documentElement.classList.add('has-language');if(gate){gate.hidden=true;}document.documentElement.lang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';const menu=document.getElementById('site-menu');if(menu)menu.setAttribute('dir',document.documentElement.dir);};
 buttons.forEach(btn=>btn.addEventListener('click',()=>choose(btn.dataset.language)));
 if(isHome && !i18n.hasPreference()) gate.hidden=false;
 if(isHome && i18n.hasPreference()){gate.hidden=true;document.documentElement.classList.add('has-language');}
 const toggle=document.getElementById('menu-toggle'),close=document.getElementById('menu-close'),menu=document.getElementById('site-menu'),backdrop=document.getElementById('menu-backdrop');
 const open=()=>{if(!menu)return;menu.classList.add('open');menu.setAttribute('aria-hidden','false');if(backdrop)backdrop.hidden=false;if(toggle)toggle.setAttribute('aria-expanded','true');document.body.style.overflow='hidden';};
 const shut=()=>{if(!menu)return;menu.classList.remove('open');menu.setAttribute('aria-hidden','true');if(backdrop)backdrop.hidden=true;if(toggle)toggle.setAttribute('aria-expanded','false');document.body.style.overflow='';};
 toggle&&toggle.addEventListener('click',open);close&&close.addEventListener('click',shut);backdrop&&backdrop.addEventListener('click',shut);document.addEventListener('keydown',e=>{if(e.key==='Escape')shut();});
 menu&&menu.querySelectorAll('a').forEach(a=>a.addEventListener('click',shut));
 document.addEventListener('consilium:language',()=>{const m=document.getElementById('site-menu');if(m)m.setAttribute('dir',document.documentElement.dir);});
}
window.addEventListener('DOMContentLoaded',init);
})();
