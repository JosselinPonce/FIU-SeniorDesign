/** DriveSense entry point; diagnostics remain optional development tools. */
import { DemoStartup } from './components/DemoStartup';
import SmartWheelScreen from './components/SmartWheelScreen';
import { ThemeProvider } from './lib/theme/ThemeProvider';
import { InformationProvider } from './components/Information';
import { LanguageProvider } from './lib/i18n/LanguageProvider';
export default function App() { return <LanguageProvider><ThemeProvider><InformationProvider><DemoStartup><SmartWheelScreen /></DemoStartup></InformationProvider></ThemeProvider></LanguageProvider>; }
