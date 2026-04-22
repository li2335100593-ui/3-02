// ==UserScript==
// @name         Carousel Auto-Injector
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  自动在目标网站注入 carousel.js 轮播脚本
// @match        https://livingroom-design.ddmmoney.com/*
// @match        https://old-house-renovation.chworld.com.tw/*
// @match        https://incar.tw/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // 加载 carousel.js
    var script = document.createElement('script');
    script.src = 'https://li2335100593-ui.github.io/3-02/carousel.js';
    script.async = true;

    // 如果 document.head 已存在，直接插入
    if (document.head) {
        document.head.appendChild(script);
    } else {
        // 否则等待 DOM 加载
        document.addEventListener('DOMContentLoaded', function() {
            document.head.appendChild(script);
        });
    }
})();
