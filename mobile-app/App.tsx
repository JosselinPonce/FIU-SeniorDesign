/** DriveSense entry point; diagnostics remain optional development tools. */
import { DemoStartup } from './components/DemoStartup';
import SmartWheelScreen from './components/SmartWheelScreen';
import { ThemeProvider } from './lib/theme/ThemeProvider';
import { InformationProvider } from './components/Information';
export default function App() { return <ThemeProvider><InformationProvider><DemoStartup><SmartWheelScreen /></DemoStartup></InformationProvider></ThemeProvider>; }
