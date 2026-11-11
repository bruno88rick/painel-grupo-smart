import asyncio, sys
async def rolar(pg):
    await pg.evaluate('async()=>{for(let y=0;y<document.body.scrollHeight;y+=400){scrollTo(0,y);await new Promise(r=>setTimeout(r,60))}scrollTo(0,0)}')
    await pg.wait_for_timeout(400)

from playwright.async_api import async_playwright
URL = 'http://127.0.0.1:8765/index.html'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/home/user/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell')
        erros = []
        for nome, w, h in [('390', 390, 844), ('desktop', 1366, 900)]:
            for tema in ['claro', 'escuro']:
                ctx = await b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2 if w == 390 else 1, color_scheme='dark' if tema == 'escuro' else 'light')
                pg = await ctx.new_page()
                pg.on('pageerror', lambda e: erros.append(str(e)))
                pg.on('console', lambda m: m.type == 'error' and erros.append(m.text))
                await pg.goto(URL); await pg.wait_for_selector('#aba-inicio h1'); await pg.wait_for_timeout(700)
                await rolar(pg); await pg.screenshot(path=f'shots/{nome}-{tema}-inicio.png', full_page=True)
                if tema == 'claro':
                    await pg.click('[data-aba=designs]'); await pg.wait_for_timeout(600)
                    await rolar(pg); await pg.screenshot(path=f'shots/{nome}-{tema}-designs.png', full_page=True)
                    await pg.click('[data-abrir="P-20261109-01"]'); await pg.wait_for_timeout(500)
                    await pg.screenshot(path=f'shots/{nome}-{tema}-detalhe.png')
                    await pg.keyboard.press('Escape')
                    await pg.click('[data-aba=posts]'); await pg.wait_for_timeout(500)
                    await rolar(pg); await pg.screenshot(path=f'shots/{nome}-{tema}-posts.png', full_page=True)
                    await pg.click('[data-aba=biblioteca]'); await pg.wait_for_timeout(600)
                    await rolar(pg); await pg.screenshot(path=f'shots/{nome}-{tema}-biblioteca.png', full_page=True)
                    # fluxo de decisão
                    await pg.click('[data-aba=inicio]'); await pg.wait_for_timeout(200)
                    await pg.click('#aba-inicio [data-ajuste="P-20261111-03"]'); await pg.wait_for_timeout(300)
                    await pg.screenshot(path=f'shots/{nome}-{tema}-ajuste.png')
                    await pg.fill('#ajuste-texto', 'Trocar a foto-9 pela foto-12 e aumentar o selo do preço')
                    await pg.click('#form-ajuste button[type=submit]'); await pg.wait_for_timeout(500)
                    await pg.click('#aba-inicio [data-aprovar="P-20261111-02"]'); await pg.wait_for_timeout(500)
                    dec = await pg.evaluate('window.__DECISOES')
                    env = await pg.locator('#aba-inicio .enviado').count()
                    print(nome, 'decisoes', [(d['item_id'], d['decisao'], d['comentario']) for d in dec], 'cartoes enviados', env)
                    await pg.screenshot(path=f'shots/{nome}-{tema}-apos-decisao.png', full_page=True)
                    # filtro
                    await pg.click('[data-aba=designs]'); await pg.click('[data-estado=refazer]'); await pg.wait_for_timeout(200)
                    print(nome, 'filtro refazer', await pg.locator('#aba-designs .cartao').count())
                    await pg.fill('#f-busca', 'presépio'); await pg.wait_for_timeout(200)
                    await pg.click('[data-estado=""]'); print(nome, 'busca presépio', await pg.locator('#aba-designs .cartao').count())
                    ov = await pg.evaluate('document.documentElement.scrollWidth > innerWidth')
                    print(nome, 'overflow horizontal', ov)
                await ctx.close()
        await b.close()
        print('erros', erros)
asyncio.run(main())
