// js/auth.js — standardized authentication token management
// Backward-compatible: reads old localStorage keys, writes to new unified key
(function() {
  'use strict';

  var STORAGE_KEY = '_3p_auth';
  var AUTH_HEADER_NAME = 'Authorization';

  function _getStored() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}

    // backward compat: try old keys
    var token = localStorage.getItem('authToken') || localStorage.getItem('token') || localStorage.getItem('auth_token') || localStorage.getItem('3dparty_admin_token');
    if (!token) return null;

    var user = null;
    try {
      user = JSON.parse(localStorage.getItem('user'));
    } catch (e) {}

    var phone = localStorage.getItem('userPhone') || (user && user.phone) || null;
    var lastLogin = localStorage.getItem('3dparty_last_login') || null;

    return { token: token, user: user, phone: phone, lastLogin: lastLogin };
  }

  function _save(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {}
  }

  var Auth = {

    getToken: function() {
      var stored = _getStored();
      return stored ? stored.token : null;
    },

    setToken: function(token, isAdmin) {
      var stored = _getStored() || {};
      stored.token = token;
      if (isAdmin) {
        stored.isAdmin = true;
      } else {
        delete stored.isAdmin;
      }
      _save(stored);
    },

    setAdminToken: function(token) {
      Auth.setToken(token, true);
    },

    isAdmin: function() {
      var stored = _getStored();
      return !!(stored && stored.isAdmin);
    },

    clearToken: function() {
      var stored = _getStored() || {};
      delete stored.token;
      delete stored.isAdmin;
      delete stored.user;
      delete stored.phone;
      _save(stored);
      try { localStorage.removeItem('authToken'); } catch (e) {}
      try { localStorage.removeItem('token'); } catch (e) {}
      try { localStorage.removeItem('auth_token'); } catch (e) {}
      try { localStorage.removeItem('3dparty_admin_token'); } catch (e) {}
    },

    getUser: function() {
      var stored = _getStored();
      return stored ? stored.user : null;
    },

    setUser: function(user) {
      var stored = _getStored() || {};
      stored.user = user;
      _save(stored);
    },

    setPhone: function(phone) {
      var stored = _getStored() || {};
      stored.phone = phone;
      _save(stored);
    },

    getPhone: function() {
      var stored = _getStored();
      return stored ? stored.phone : null;
    },

    isLoggedIn: function() {
      return !!Auth.getToken();
    },

    getApiHeaders: function() {
      var headers = { 'Content-Type': 'application/json' };
      var token = Auth.getToken();
      if (token) {
        headers[AUTH_HEADER_NAME] = 'Bearer ' + token;
      }
      return headers;
    },

    logout: function(serverLogoutUrl) {
      var token = Auth.getToken();
      var phone = Auth.getPhone();
      if (serverLogoutUrl) {
        fetch(serverLogoutUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: phone, token: token })
        }).catch(function () {});
      }
      Auth.clearToken();
      try { localStorage.removeItem('user'); } catch (e) {}
      try { localStorage.removeItem('userPhone'); } catch (e) {}
      try { localStorage.setItem('3dparty_last_login', new Date().toISOString()); } catch (e) {}
    },

    markLogin: function() {
      try { localStorage.setItem('3dparty_last_login', new Date().toISOString()); } catch (e) {}
    }

  };

  window.Auth = Auth;
})();
