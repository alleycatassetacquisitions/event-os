(() => {
  const video = document.getElementById("subject-video");
  if (video) {
    video.play().catch(() => {
      /* autoplay may be blocked until unmute — muted loop should usually work */
    });
  }

  // Occasional micro-glitch on the wanted title for presence
  const title = document.querySelector(".wanted-title");
  if (!title) return;
  setInterval(() => {
    title.style.transform = `translateX(${Math.random() > 0.7 ? 2 : 0}px)`;
    setTimeout(() => {
      title.style.transform = "translateX(0)";
    }, 80);
  }, 3200);
})();
