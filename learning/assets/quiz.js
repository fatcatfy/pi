// quiz.js — 所有 lesson 共用的 quiz 组件
//
// 用法（HTML 结构）：
//   <div class="quiz">
//     <div class="question" data-explain="正确后的提示语" data-explain-wrong="选错时的提示语">
//       <p class="q">问题文本</p>
//       <button class="option" data-correct="true">正确选项</button>
//       <button class="option" data-correct="false">错误选项</button>
//       ...
//       <p class="feedback"></p>
//     </div>
//   </div>
//
// 行为：点选后立即反馈并锁定该题；选错时自动标出正确选项（.reveal）。
(function () {
	"use strict";

	function setup(question) {
		var options = question.querySelectorAll(".option");
		var feedback = question.querySelector(".feedback");
		var answered = false;

		Array.prototype.forEach.call(options, function (option) {
			option.disabled = false;
			option.addEventListener("click", function () {
				if (answered) {
					return;
				}
				answered = true;
				Array.prototype.forEach.call(options, function (o) {
					o.disabled = true;
				});

				var isCorrect = option.getAttribute("data-correct") === "true";
				var message;
				if (isCorrect) {
					option.classList.add("correct");
					message = question.getAttribute("data-explain") || "正确。";
				} else {
					option.classList.add("wrong");
					Array.prototype.forEach.call(options, function (o) {
						if (o.getAttribute("data-correct") === "true") {
							o.classList.add("reveal");
						}
					});
					message = question.getAttribute("data-explain-wrong") || "不对——回顾上面的内容再想想。";
				}
				if (feedback) {
					feedback.textContent = message;
				}
			});
		});
	}

	function init() {
		var questions = document.querySelectorAll(".question");
		Array.prototype.forEach.call(questions, setup);
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})();