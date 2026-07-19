# Extensão opcional: gera a matriz do QR code do link do kanban.
# Ativa automaticamente quando o usuário carrega QRCoders na sessão
# (`using QRCoders`), no mesmo padrão das extensões BusinessDays/Makie.
module PerthQRCodersExt

using Perth
using QRCoders

# BitMatrix sem quiet zone (o render — terminal ou browser — põe a borda)
Perth._qr_matrix(text::AbstractString) = QRCoders.qrcode(text)

end # module
