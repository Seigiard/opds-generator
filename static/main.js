(function () {
  "use strict";

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

  document.readyState === "loading"
    ? document.addEventListener("DOMContentLoaded", initFocusTraps)
    : initFocusTraps();
})();
