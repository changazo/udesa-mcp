def sumar_pares(numeros):
    total = 0
    for numero in numeros:
        if numero % 2 == 0:
            total = total + numero
    return total
