// Page chunk loaders shared between React.lazy wrappers and the nav bar's
// hover-prefetch so navigation feels instant after a split-page build.
export function loadMonitoringPage() {
  return import("../components/MonitoringPage");
}
export function loadSettingsPage() {
  return import("../components/SettingsPage");
}
export function loadAboutPage() {
  return import("../components/AboutPage");
}
