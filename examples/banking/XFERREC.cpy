      *----------------------------------------------------------------
      * XFERREC : OUTGOING SEPA CREDIT TRANSFER (TABLE TRANSFERS)
      * MUE EXAMPLE - FICTIONAL SYSTEM
      *----------------------------------------------------------------
       01  XFER-REC.
           05  XFER-REFERENCE      PIC X(16).
           05  XFER-CUSTOMER       PIC X(10).
           05  XFER-IBAN.
               10  XFER-IBAN-COUNTRY PIC X(2).
               10  XFER-IBAN-CHECK PIC 9(2).
               10  XFER-IBAN-BBAN  PIC X(30).
           05  XFER-IBAN-LENGTH    PIC 9(2).
           05  XFER-AMOUNT         PIC 9(9)V99   COMP-3.
      *    STATUS : OK00 SENT, AT02 ON HOLD, RJ01 REJECTED
           05  XFER-STATUS         PIC X(4).
