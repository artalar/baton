import { h, mount } from '@reatom/jsx'

const Placeholder = () => (
  <main>
    <h1>2048</h1>
  </main>
)

const root = document.getElementById('app')
if (!root) throw new Error('missing #app')

const { unmount } = mount(root, <Placeholder />)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unmount()
  })
}
