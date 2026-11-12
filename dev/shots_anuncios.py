import asyncio, sys
from playwright.async_api import async_playwright
URL = 'http://127.0.0.1:8765/' + (sys.argv[2] if len(sys.argv)>2 else 'index.html')
SUF = sys.argv[1] if len(sys.argv) > 1 else ''
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
                pre = f'shots/an{SUF}-{nome}-{tema}'
                await pg.screenshot(path=f'{pre}-inicio.png', full_page=True)
                for aba in ['posts', 'campanhas']:
                    await pg.click(f'[data-aba={aba}]'); await pg.wait_for_timeout(500)
                    await pg.screenshot(path=f'{pre}-{aba}.png', full_page=True)
                    print(nome, tema, aba, 'overflow', await pg.evaluate('document.documentElement.scrollWidth > innerWidth'))
                await pg.click('[data-aba=posts]')
                if await pg.locator('#aba-posts [data-anpost="post:P-20261112-CAT"]').count():
                    await pg.locator('#aba-posts [data-anpost="post:P-20261112-CAT"]').first.click(); await pg.wait_for_timeout(600)
                    await pg.screenshot(path=f'{pre}-carrossel.png')
                    tr = pg.locator('#folha .galeria-trilho')
                    if w == 390:
                        n = await tr.evaluate('t=>t.children.length')
                        await tr.evaluate('t=>t.scrollTo({left:t.clientWidth*9})'); await pg.wait_for_timeout(500)
                        print(nome, 'itens', n, 'contador', await pg.locator('#folha [data-galeria-pos]').inner_text(), 'overflow folha', await pg.evaluate('document.documentElement.scrollWidth > innerWidth'))
                        await pg.screenshot(path=f'{pre}-carrossel-10.png')
                    await pg.evaluate('document.querySelector("#folha .folha-caixa").scrollTo(0,99999)'); await pg.wait_for_timeout(300)
                    await pg.screenshot(path=f'{pre}-carrossel-fim.png')
                    await pg.keyboard.press('Escape')
                await pg.click('[data-aba=campanhas]'); await pg.wait_for_timeout(300)
                await pg.locator('#aba-campanhas [data-ancamp="campanha:C02"]').first.click(); await pg.wait_for_timeout(500)
                await pg.screenshot(path=f'{pre}-plano.png')
                await pg.keyboard.press('Escape')
                await pg.locator('#aba-campanhas [data-ancamp="campanha:M-52562345108818"]').first.click(); await pg.wait_for_timeout(500)
                await pg.screenshot(path=f'{pre}-ativa.png')
                btn = pg.locator('#folha [data-an-dec]')
                print(nome, tema, 'botoes', await btn.count(), 'desabilitados', await pg.locator('#folha [data-an-dec]:disabled').count())
                if SUF == '-int' and tema == 'claro':
                    await pg.locator('#folha [data-an-dec=pausar]').click(); await pg.wait_for_timeout(300)
                    await pg.screenshot(path=f'{pre}-dialogo-pausar.png')
                    await pg.fill('#an-texto', 'Pausar até o Natal'); await pg.click('#an-enviar'); await pg.wait_for_timeout(500)
                    await pg.keyboard.press('Escape')
                    await pg.click('[data-aba=posts]'); await pg.locator('#aba-posts [data-anpost="post:P-20261112-CAT"]').first.click(); await pg.wait_for_timeout(400)
                    await pg.locator('#folha [data-an-dec=aprovar][data-leg="2"]').click(); await pg.wait_for_timeout(300)
                    await pg.fill('#an-horario', '2026-11-13 19:00'); await pg.click('#an-enviar'); await pg.wait_for_timeout(500)
                    print(nome, 'decisoes', await pg.evaluate('window.__DECISOES.map(d=>[d.modulo,d.tipo_item,d.item_id,d.decisao,d.comentario])'))
                    await pg.keyboard.press('Escape')
                    await pg.click('[data-aba=inicio]'); await pg.wait_for_timeout(300)
                    await pg.screenshot(path=f'{pre}-apos-decisao.png', full_page=True)
                await ctx.close()
        await b.close()
        print('erros', erros)
asyncio.run(main())
