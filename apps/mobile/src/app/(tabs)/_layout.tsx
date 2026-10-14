import { Tabs } from "expo-router";
import { LayoutGrid, ListOrdered, ScanLine, Settings2, Sparkles } from "lucide-react-native";
import { useTheme } from "@/components/ui";

export default function TabsLayout() {
  const t = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        animation: "fade",
        tabBarActiveTintColor: t.primary,
        tabBarInactiveTintColor: t.muted,
        tabBarStyle: { backgroundColor: t.dark ? "#1a1b1f" : "#f7f6f2", borderTopColor: t.dark ? "#33343a" : "#e6e4de" },
        tabBarLabelStyle: { fontSize: 10 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Áttekintés", tabBarIcon: ({ color }) => <LayoutGrid size={20} color={color} /> }} />
      <Tabs.Screen name="transactions" options={{ title: "Tételek", tabBarIcon: ({ color }) => <ListOrdered size={20} color={color} /> }} />
      <Tabs.Screen name="scan" options={{ title: "Blokk", tabBarIcon: ({ color }) => <ScanLine size={20} color={color} /> }} />
      <Tabs.Screen name="insights" options={{ title: "Elemzés", tabBarIcon: ({ color }) => <Sparkles size={20} color={color} /> }} />
      <Tabs.Screen name="settings" options={{ title: "Beállítások", tabBarIcon: ({ color }) => <Settings2 size={20} color={color} /> }} />
    </Tabs>
  );
}
