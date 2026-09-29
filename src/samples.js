export const SAMPLES = [
  {
    name: 'Hello, world',
    code: `; Classic DOS .COM program
        org 100h

start:  mov ah, 09h          ; DOS: print $-terminated string
        mov dx, msg
        int 21h

        mov ah, 4Ch          ; DOS: terminate
        mov al, 0
        int 21h

msg:    db 'Hello, world!', 0Dh, 0Ah, '$'
`,
  },
  {
    name: 'Counter loop',
    code: `; Print the digits 0-9 using a loop
        org 100h

        mov cx, 10
        mov dl, '0'
next:   mov ah, 02h          ; DOS: print char in DL
        int 21h
        inc dl
        loop next

        mov ah, 02h
        mov dl, 0Dh
        int 21h
        mov dl, 0Ah
        int 21h

        mov ax, 4C00h
        int 21h
`,
  },
  {
    name: 'Fibonacci (16-bit)',
    code: `; Print Fibonacci numbers below 1000
        org 100h

        mov word [a], 0
        mov word [b], 1
loop1:  mov ax, [b]
        cmp ax, 1000
        ja  done
        call print_ax
        mov ax, [a]
        add ax, [b]
        mov bx, [b]
        mov [a], bx
        mov [b], ax
        jmp loop1
done:   mov ax, 4C00h
        int 21h

; print AX as unsigned decimal followed by a space
print_ax:
        push ax
        push bx
        push cx
        push dx
        mov cx, 0
        mov bx, 10
.divide:
        mov dx, 0
        div bx               ; DX:AX / 10 -> AX rem DX
        push dx
        inc cx
        cmp ax, 0
        jnz .divide
.emit:
        pop dx
        add dl, '0'
        mov ah, 02h
        int 21h
        loop .emit
        mov ah, 02h
        mov dl, ' '
        int 21h
        pop dx
        pop cx
        pop bx
        pop ax
        ret

a:      dw 0
b:      dw 0
`,
  },
  {
    name: 'String reverse (string ops)',
    code: `; Copy a string backwards with lodsb/stosb
        org 100h

        mov si, src
        mov di, dst
        add si, len-1
        std                  ; walk source downwards
        mov cx, len
copy:   lodsb
        cld
        stosb
        std
        loop copy
        cld

        mov ah, 09h
        mov dx, dst
        int 21h

        mov ax, 4C00h
        int 21h

src:    db 'emulator 6808'
len     equ 13
dst:    db 13 dup(0)
        db 0Dh, 0Ah, '$'
`,
  },
  {
    name: 'Echo typed keys',
    code: `; Read keys and echo them; ESC quits.
        org 100h

        mov ah, 09h
        mov dx, prompt
        int 21h
loop1:  mov ah, 01h          ; DOS: read char with echo
        int 21h
        cmp al, 1Bh          ; ESC?
        je  bye
        cmp al, 0Dh
        jne loop1
        mov ah, 02h
        mov dl, 0Ah
        int 21h
        jmp loop1
bye:    mov ah, 09h
        mov dx, outro
        int 21h
        mov ax, 4C00h
        int 21h

prompt: db 'Type something (ESC to quit):', 0Dh, 0Ah, '$'
outro:  db 0Dh, 0Ah, 'bye!', 0Dh, 0Ah, '$'
`,
  },
  {
    name: 'Direct video memory',
    code: `; Write coloured cells straight into B800:0000 text RAM
        org 100h

        mov ax, 0B800h
        mov es, ax
        xor di, di
        mov cx, 80*25
        mov ax, 0720h        ; attr 07, space
fill:   stosw
        loop fill

        mov di, (12*80 + 32) * 2
        mov si, text
        mov ah, 1Eh          ; yellow on blue
show:   lodsb
        cmp al, 0
        je  done
        stosw
        jmp show
done:   mov ax, 4C00h
        int 21h

text:   db '8086 EMULATOR', 0
`,
  },
  {
    name: 'Keyboard scancode probe',
    code: `; Show BIOS keyboard scan/ASCII bytes and live Shift/Ctrl/Alt flags.
        org 100h

start:  mov dx, heading
        mov ah, 09h
        int 21h
        mov byte [last_modifiers], 0FFh

poll:   mov ah, 02h          ; BIOS: read keyboard shift flags
        int 16h
        and al, 0Fh           ; bits 0-3 = RShift, LShift, Ctrl, Alt
        cmp al, [last_modifiers]
        je  check_key
        mov [last_modifiers], al
        mov dx, modifier_label
        mov ah, 09h
        int 21h
        mov al, [last_modifiers]
        call print_hex_byte
        mov dx, newline
        mov ah, 09h
        int 21h

check_key:
        mov ah, 01h          ; BIOS: check for a queued key
        int 16h
        jz  poll
        mov ah, 00h          ; BIOS: read AX = scan code:ASCII
        int 16h
        mov [key_ascii], al
        mov [key_scan], ah
        mov dx, scan_label
        mov ah, 09h
        int 21h
        mov al, [key_scan]
        call print_hex_byte
        mov dx, ascii_label
        mov ah, 09h
        int 21h
        mov al, [key_ascii]
        call print_hex_byte
        mov dl, 0Dh
        mov ah, 02h
        int 21h
        mov dl, 0Ah
        mov ah, 02h
        int 21h
        cmp byte [key_ascii], 1Bh ; ESC quits
        jne poll
        mov ax, 4C00h
        int 21h

; AL contains a byte; print two uppercase hexadecimal digits.
print_hex_byte:
        push ax
        push bx
        mov bl, al
        mov al, bl
        mov cl, 4
        shr al, cl
        call print_hex_digit
        mov al, bl
        and al, 0Fh
        call print_hex_digit
        pop bx
        pop ax
        ret

print_hex_digit:
        cmp al, 10
        jb  print_decimal_digit
        add al, 'A'-10
        jmp short emit_digit
print_decimal_digit:
        add al, '0'
emit_digit:
        mov dl, al
        mov ah, 02h
        int 21h
        ret

heading:    db 'Type keys: scan/ASCII. mod bits: 0=RShift 1=LShift 2=Ctrl 3=Alt.', 0Dh, 0Ah, '$'
modifier_label: db 'mods=$'
newline:    db 0Dh, 0Ah, '$'
scan_label: db 'scan=$'
ascii_label: db ' ascii=$'
last_modifiers: db 0FFh
key_scan:   db 0
key_ascii:  db 0
`,
  },
];
