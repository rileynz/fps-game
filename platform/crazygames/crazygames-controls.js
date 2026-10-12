(function bindCrazyGamesControls(){
  'use strict';

  function closest(event,selector){
    return event.target instanceof Element?event.target.closest(selector):null;
  }

  document.addEventListener('click',event=>{
    let target=closest(event,'#important-banner-close');
    if(target){
      event.preventDefault();
      event.stopPropagation();
      window.dismissImportantAnnouncement?.(event);
      return;
    }

    target=closest(event,'#important-banner,#menu-announcement-preview,#btn-announcements,#announcement-toast');
    if(target){window.openAnnouncements?.();return;}
    if(closest(event,'#announcements-close')){window.closeAnnouncements?.();return;}
    if(closest(event,'#settings-menu-btn')){window.openSettings?.();return;}
    if(closest(event,'#weapon-chip')){window.toggleWeaponPanel?.();return;}
    if(closest(event,'#spectate-next-btn')){window.cycleSpectateTarget?.();return;}

    target=closest(event,'.mode-btn[data-mode]');
    if(target){window.setMode?.(target.dataset.mode);return;}

    target=closest(event,'.weapon-btn[data-weapon]');
    if(target){
      window.chooseWeapon?.(target.dataset.weapon,!!target.closest('#dead-weapons'));
      return;
    }

    if(closest(event,'#btn-weekly,#weekly-hud-btn')){window.openWeekly?.();return;}
    if(closest(event,'#weekly-close')){window.closeWeekly?.();return;}
    target=closest(event,'.wtab[data-week]');
    if(target){window.showWeeklyTab?.(target.dataset.week);return;}

    if(closest(event,'#btn-daily')){window.openDaily?.();return;}
    if(closest(event,'#daily-close')){window.closeDaily?.();return;}
    target=closest(event,'.challenge-tab[data-challenge-tab]');
    if(target){window.showChallengeTab?.(target.dataset.challengeTab);return;}

    if(closest(event,'#rank-hud-badge')){window.openRankPanel?.();return;}
    if(closest(event,'#rp-close')){window.closeRankPanel?.();}
  });
})();
