import { EditorLayout } from './components/EditorLayout'
import { SlideDocProvider } from './state/SlideDocProvider'

export function App() {
  return (
    <SlideDocProvider>
      <EditorLayout />
    </SlideDocProvider>
  )
}
