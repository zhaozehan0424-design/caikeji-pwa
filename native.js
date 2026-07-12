(() => {
  const capacitor = window.Capacitor;
  if (!capacitor?.isNativePlatform?.()) return;

  document.documentElement.classList.add("is-native-ios");
  const plugins = capacitor.Plugins || {};

  const ignoreFailure = (promise) => promise?.catch?.(() => {});
  ignoreFailure(plugins.StatusBar?.setStyle?.({ style: "DARK" }));

  window.CaikejiNative = {
    answer(correct) {
      ignoreFailure(
        plugins.Haptics?.notification?.({ type: correct ? "SUCCESS" : "WARNING" }),
      );
    },
    rating(rating) {
      ignoreFailure(
        plugins.Haptics?.impact?.({ style: rating === 0 ? "HEAVY" : rating === 1 ? "MEDIUM" : "LIGHT" }),
      );
    },
  };

  window.addEventListener("load", () => {
    ignoreFailure(plugins.SplashScreen?.hide?.());
  });
})();
