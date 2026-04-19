import { EditorLayout } from './components/EditorLayout'
import { SlideDocProvider } from './state/SlideDocProvider'
import { SelectionProvider } from './state/SelectionContext'
import { ToolProvider } from './state/ToolContext'

export function App() {
  return (
    <SlideDocProvider>
      <SelectionProvider>
        <ToolProvider>
          <EditorLayout />
        </ToolProvider>
      </SelectionProvider>
    </SlideDocProvider>
  )
}
