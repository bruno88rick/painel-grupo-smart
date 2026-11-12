import asyncio
from playwright.async_api import async_playwright
URL = 'http://127.0.0.1:8765/index.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/home/user/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell')
        erros = []
        for nome, w, h in [('390', 390, 844), ('desktop', 1366, 900)]:
            ctx = await b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if w == 390 else 1)
            pg = await ctx.new_page()
            pg.on('pageerror', lambda e: erros.append(str(e)))
            pg.on('console', lambda m: m.type == 'error' and erros.append(m.text))
            await pg.goto(URL); await pg.wait_for_selector('#aba-inicio h1'); await pg.wait_for_timeout(700)
            await pg.click('[data-aba=posts]'); await pg.wait_for_timeout(500)
            el = pg.locator('#aba-posts [data-anpost="post:P-20261109-03"]')
            print(nome, 'cartoes P-20261109-03:', await el.count(), 'ORG-04:', await pg.locator('[data-anpost="post:ORG-20261111-04"]').count())
            await el.evaluate('e=>e.scrollIntoView({block:"center"})'); await pg.wait_for_timeout(300)
            await pg.screenshot(path=f'shots/v201-{nome}-posts.png')
            await el.click(); await pg.wait_for_timeout(600)
            await pg.evaluate('(()=>{const d=[...document.querySelectorAll("#folha dt")].find(x=>x.textContent=="Programações"); if(d) d.scrollIntoView({block:"center"})})()'); await pg.wait_for_timeout(300)
            await pg.screenshot(path=f'shots/v201-{nome}-post-detalhe.png')
            await pg.keyboard.press('Escape')
            await pg.click('[data-aba=campanhas]'); await pg.wait_for_timeout(500)
            print(nome, 'ativas:', await pg.locator('#aba-campanhas [data-ancamp^="campanha:"]').count(), 'overflow', await pg.evaluate('document.documentElement.scrollWidth > innerWidth'))
            await pg.screenshot(path=f'shots/v201-{nome}-campanhas.png', full_page=True)
            await ctx.close()
        print('erros', erros)
        await b.close()
asyncio.run(main())
