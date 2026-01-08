/*
  Gridnav - a way to navigate lists with a keyboard in a
  2D fashion instea of item-by-item
  Copyright (c) 2016 Christian Heilmann
  Licensed under the MIT license:
  http://www.opensource.org/licenses/mit-license.php
  Version:  1.0.0
*/
var Gridnav = function (listelement) {
  var that = this;
  this.list = typeof listelement === "string" ? document.querySelector(listelement) : listelement;
  if (!this.list) {
    throw Error("List item could not be found");
  }
  this.setcodes = function (amount) {
    that.codes = {
      39: 1,
      68: 1,
      65: -1,
      37: -1,
      87: -that.amount,
      38: -that.amount,
      83: that.amount,
      40: that.amount,
    };
  };
  if (!this.list.getAttribute("data-element")) {
    this.element = this.list.firstElementChild.firstElementChild.tagName;
  } else {
    this.element = this.list.getAttribute("data-element");
  }
  if (!this.list.getAttribute("data-amount")) {
    this.amount = 6502;
    this.setcodes(this.amount);
  } else {
    this.amount = +this.list.getAttribute("data-amount");
    this.setcodes(this.amount);
  }
  this.setcodes(this.amount);
  this.all = this.list.querySelectorAll(this.element);
  this.keynav = function (ev) {
    var t = ev.target;
    var c;
    var posx, posy;
    if (t.matches && t.matches(that.element)) {
      for (var i = 0; i < that.all.length; i++) {
        if (that.all[i] === t) {
          c = i;
          posx = that.all[c].offsetLeft;
          posy = that.all[c].offsetTop;
          break;
        }
      }
      if (that.codes[ev.keyCode]) {
        var kc = that.codes[ev.keyCode];
        if (kc > -6502 && kc < 6502) {
          if (that.all[c + kc]) {
            that.all[c + kc].focus();
          }
        } else {
          var add = kc < 0 ? -1 : 1;
          while (that.all[i]) {
            if (that.all[i].offsetLeft === posx && that.all[i].offsetTop !== posy) {
              that.all[i].focus();
              break;
            }
            i += add;
          }
        }
      }
    }
  };
  this.list.addEventListener("keyup", this.keynav);
};
Gridnav.lists = [];

(function () {
  "use strict";

  function init() {
    initGridNav();
    initFocusTraps();
  }

  function initGridNav() {
    if (!Gridnav) return;
    const a = new Gridnav(".books-grid");
    console.log(a);
  }

  function handleEnterKey(checkbox, forceValue) {
    return function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      checkbox.checked = forceValue !== undefined ? forceValue : !checkbox.checked;
      checkbox.dispatchEvent(new Event("change"));
    };
  }

  function initFocusTraps() {
    if (!window.focusTrap) return;

    document.querySelectorAll("[data-focus-group]").forEach(function (popup) {
      const groupId = popup.getAttribute("data-focus-group");
      const checkbox = document.getElementById("checkbox-" + groupId);
      if (!checkbox) return;

      const trap = window.focusTrap.createFocusTrap(popup, {
        escapeDeactivates: true,
        clickOutsideDeactivates: true,
        onDeactivate: function () {
          checkbox.checked = false;
        },
      });

      checkbox.addEventListener("change", function () {
        checkbox.checked ? trap.activate() : trap.deactivate();
      });

      checkbox.addEventListener("keydown", handleEnterKey(checkbox));

      const closeLabel = popup.querySelector('[for="checkbox-' + groupId + '"]');
      if (closeLabel) {
        closeLabel.addEventListener("keydown", handleEnterKey(checkbox, false));
      }
    });
  }

  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init();
})();
