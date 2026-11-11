import asyncio
from playwright.async_api import async_playwright
EXE='/home/user/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=EXE)
        erros=[]
        for nome,w,h,esc in [('390',390,844,2),('desktop',1366,900,1)]:
            pg = await b.new_page(viewport={'width':w,'height':h}, device_scale_factor=esc)
            pg.on('pageerror', lambda e: erros.append(str(e)))
            await pg.goto('http://127.0.0.1:8765/index.html'); await pg.wait_for_selector('#aba-inicio h1'); await pg.wait_for_timeout(800)
            await pg.screenshot(path=f'shots/v2-{nome}-inicio.png', full_page=True)
            await pg.click('[data-aba=posts]'); await pg.wait_for_timeout(500)
            await pg.screenshot(path=f'shots/v2-{nome}-posts.png', full_page=True)
            await pg.click('[data-aba=inicio]'); await pg.wait_for_timeout(200)
            print(nome, 'botões', await pg.locator('#aba-inicio [data-aprovar]').all_inner_texts())
            # recusa por versão obsoleta
            await pg.evaluate('window.__FORCAR_OBSOLETO = true')
            await pg.click('#aba-inicio [data-aprovar="P-20261111-02"]'); await pg.wait_for_timeout(450)
            print(nome, 'toast', await pg.locator('#toast').inner_text())
            await pg.screenshot(path=f'shots/v2-{nome}-recusa-obsoleta.png')
            await pg.wait_for_timeout(800)
            print(nome, 'gravadas', await pg.evaluate('window.__DECISOES.length'))
            await pg.close()
        print('erros', erros)
        await b.close()
asyncio.run(main())
