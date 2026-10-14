import { Alert, Platform } from "react-native";

// react-native-web's Alert.alert does nothing, so the Expo web build uses the browser's own dialogs instead.

export function showError(title: string, message: string) {
  if (Platform.OS === "web") window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

/** Asks before a destructive action; onConfirm runs only on yes. */
export function confirmDestructive(title: string, message: string, action: string, onConfirm: () => void) {
  if (Platform.OS === "web") {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: "Mégse", style: "cancel" },
    { text: action, style: "destructive", onPress: onConfirm },
  ]);
}
