// js/utils.js — shared frontend utility functions (no dependencies)
(function() {
  'use strict';

  var Utils = {

    escapeHtml: function(text) {
      if (text == null || text === '') return '';
      var div = document.createElement('div');
      div.textContent = String(text);
      return div.innerHTML;
    },

    formatTime: function(isoString) {
      if (!isoString) return '';
      var date = new Date(isoString);
      if (isNaN(date.getTime())) return String(isoString);
      var diff = Math.floor((Date.now() - date.getTime()) / 1000);
      if (diff < 60) return 'just now';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
      return date.toLocaleDateString();
    },

    formatDate: function(isoString) {
      if (!isoString) return '';
      var date = new Date(isoString);
      if (isNaN(date.getTime())) return String(isoString);
      return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    },

    formatCurrency: function(amount, currency) {
      currency = currency || 'MVR';
      if (amount == null || isNaN(amount)) return currency + ' 0';
      return currency + ' ' + Number(amount).toLocaleString();
    }

  };

  window.Utils = Utils;
})();
